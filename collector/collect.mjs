// Brawl Counter — coletor de dados ao vivo.
// Lê a API oficial do Brawl Stars (via proxy), junta as partidas recentes dos
// jogadores do topo do ranking e calcula win rate, modos, mapas, matchups,
// sinergia e trios numa janela móvel de N dias.
//
// Uso:  BS_API_KEY=... node collector/collect.mjs
// Variáveis opcionais:
//   BS_API_BASE   (padrão https://bsproxy.royaleapi.dev/v1)
//   COUNTRIES     (padrão "global,BR,US,MX,ES")
//   PER_COUNTRY   (padrão 200)       WINDOW_DAYS (padrão 7)
//   STATE_DIR     (padrão state)     OUT_FILE    (padrão site/data/live.json)
//   CONCURRENCY   (padrão 6)
// Sem dependências: Node 20+ (fetch nativo).

import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.BS_API_KEY;
const BASE = (process.env.BS_API_BASE || 'https://bsproxy.royaleapi.dev/v1').replace(/\/$/, '');
const COUNTRIES = (process.env.COUNTRIES || 'global,BR,US,MX,ES,AR,CO,CL,PE,DE,FR,IT,PL,TR,KR,JP').split(',').map(s => s.trim()).filter(Boolean);
const PER_COUNTRY = +(process.env.PER_COUNTRY || 200);
const WINDOW_DAYS = +(process.env.WINDOW_DAYS || 7);
const STATE_DIR = process.env.STATE_DIR || 'state';
const OUT_FILE = process.env.OUT_FILE || 'site/data/live.json';
const CONCURRENCY = +(process.env.CONCURRENCY || 6);

if (!KEY) { console.error('Falta BS_API_KEY (segredo do repositório).'); process.exit(1); }

const MODE = { gemGrab: 'GG', brawlBall: 'BB', heist: 'HE', bounty: 'BO', hotZone: 'HZ', knockout: 'KO',
  wipeout: 'WO', brawlHockey: 'HK', basketBrawl: 'BK', volleyBrawl: 'VB', duels: 'DU', wipeout5V5: 'WO5',
  knockout5V5: 'KO5', brawlBall5V5: 'BB5', gemGrab5V5: 'GG5', paintBrawl: 'PB', trophyEscape: 'TE' };
const RANKED_TYPES = new Set(['soloRanked', 'teamRanked']);

/* ---------------- HTTP ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0, failures = 0;
async function api(p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    calls++;
    try {
      const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1) ** 2); continue; }
      if (r.status === 404) return null;
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status} em ${p}: ${t.slice(0, 200)}`); }
      return await r.json();
    } catch (e) {
      if (String(e.message).startsWith('HTTP 403') || String(e.message).startsWith('HTTP 401')) throw e;
      if (i === tries - 1) { failures++; console.warn('falhou', p, e.message); return null; }
      await sleep(600 * (i + 1));
    }
  }
  failures++; return null;
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const enc = tag => encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/* ------------- tempo ------------- */
// battleTime vem como 20261025T165203.000Z
function parseBT(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
const dayKey = t => new Date(t).toISOString().slice(0, 10);

/* ------------- estado ------------- */
async function readJSON(f, d) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } }
async function writeJSON(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v)); }
const SECS = ['b', 'mode', 'map', 'vs', 'with', 'trio', 'mtrio'];
function emptyQ() { return { battles: 0, b: {}, mode: {}, map: {}, vs: {}, with: {}, trio: {}, mtrio: {} }; }
// Filas: c = casual (troféus). Ranqueada separada por faixa de elo (média do elo dos 6 jogadores):
// no log de ranqueada, brawler.trophies traz o elo (1..22). Faixas: 10 Diamante, 13 Mítico, 16 Lendário, 19 Mestre, 22 Pro.
// 'r' (dias antigos) = partidas com média >= 16, sem faixa exata.
const BANDS = [10, 13, 16, 19, 22];
const QKEYS = ['c', 'r', ...BANDS.map(b => 'r' + b)];
const emptyQs = () => Object.fromEntries(QKEYS.map(k => [k, emptyQ()]));
function emptyDay() { return { battles: 0, ranked: 0, b: {}, mode: {}, map: {}, vs: {}, with: {}, trio: {}, mtrio: {}, mapNames: {}, q: emptyQs(), sd: {}, sdp: {} }; }
function queueOf(bt, teams) {
  if (RANKED_TYPES.has(bt.type)) {
    const r = teams.flat().map(p => p.brawler?.trophies).filter(x => typeof x === 'number');
    if (r.length === 6 && r.every(x => x >= 1 && x <= 22)) { const avg = r.reduce((a, b) => a + b, 0) / r.length;
      let band = null; for (const b of BANDS) if (avg >= b) band = b; return band ? 'r' + band : null; }
    return null; // sem elo confiável: fica fora da ranqueada
  }
  return bt.type === 'ranked' || !bt.type ? 'c' : null;
}
// Combate Solo/Duplo: só sabemos a posição do dono do log. "Top" = metade de cima (solo 1º–4º, duplo 1º–2º).
const SD_MODES = { soloShowdown: 'SD', duoShowdown: 'DSD' };
function addBattle(d, T, win, mode, map) {
  d.battles++;
  T.forEach((tm, i) => {
    const w = i === win ? 1 : 0, enemy = T[1 - i];
    for (const n of tm) {
      inc(d.b, n, 1, w); inc(d.mode, n + '|' + mode, 1, w);
      if (map) inc(d.map, n + '|' + map, 1, w);
      for (const e of enemy) inc(d.vs, n + '|' + e, 1, w);
      for (const m of tm) if (m !== n) inc(d.with, n + '|' + m, 1, w);
    }
    const key = [...tm].sort().join(',');
    inc(d.trio, mode + '|' + key, 1, w);
    if (map) inc(d.mtrio, map + '|' + key, 1, w);
  });
}
const incR = (o, k, w, r) => { const x = o[k] || (o[k] = [0, 0, 0]); x[0]++; x[1] += w; x[2] += r; };
const inc = (o, k, g, w) => { const x = o[k] || (o[k] = [0, 0]); x[0] += g; x[1] += w; };

/* ------------- coleta ------------- */
async function main() {
  const t0 = Date.now();
  const meta = await readJSON(path.join(STATE_DIR, 'meta.json'), { lastCutoff: 0 });
  const cutoff = meta.lastCutoff || (t0 - WINDOW_DAYS * 864e5);

  // brawlers (nomes e ids oficiais)
  const br = await api('/brawlers?limit=200');
  if (!br || !br.items) throw new Error('Não foi possível ler /brawlers (chave ou proxy?)');
  const brawlers = br.items.map(x => ({ id: x.id - 16000000, name: x.name,
    gadgets: (x.gadgets || []).map(g => g.name), starPowers: (x.starPowers || []).map(s => s.name) }));

  // rotação de mapas
  const rot = (await api('/events/rotation')) || [];

  // jogadores do topo
  const tags = new Set();
  for (const c of COUNTRIES) {
    const r = await api(`/rankings/${c}/players?limit=${PER_COUNTRY}`);
    (r?.items || []).forEach(p => tags.add(p.tag));
  }
  const players = [...tags];
  console.log(`jogadores: ${players.length}`);

  const days = {}; const seen = new Set();
  const logs = await pool(players, CONCURRENCY, async tag => { const l = await api(`/players/${enc(tag)}/battlelog`); if (l) l.__tag = tag; return l; });
  for (const log of logs) {
    for (const it of (log?.items || [])) {
      const t = parseBT(it.battleTime); if (!(t > cutoff && t <= t0)) continue;
      const bt = it.battle || {}; const teams = bt.teams;
      const sdm = SD_MODES[it.event?.mode || bt.mode];
      if (sdm && typeof bt.rank === 'number' && it.event?.id && (bt.type === 'ranked' || !bt.type)) {
        const key = it.battleTime + '|' + log.__tag; if (seen.has(key)) continue; seen.add(key);
        const map = String(it.event.id), d = days[dayKey(t)] || (days[dayKey(t)] = emptyDay());
        if (it.event.map) d.mapNames[map] = [it.event.map, sdm];
        if (sdm === 'SD') { const me = (bt.players || []).find(p => p.tag === log.__tag); const n = me?.brawler?.name; if (!n) continue;
          incR(d.sd, map + '|' + n, bt.rank <= 4 ? 1 : 0, bt.rank); }
        else { const tm = (bt.teams || []).find(x => x.some(p => p.tag === log.__tag)); if (!tm || tm.length !== 2) continue;
          const me = tm.find(p => p.tag === log.__tag), mate = tm.find(p => p.tag !== log.__tag); const n = me?.brawler?.name; if (!n) continue;
          const w = bt.rank <= 2 ? 1 : 0; incR(d.sd, map + '|' + n, w, bt.rank);
          if (mate?.brawler?.name) incR(d.sdp, map + '|' + [n, mate.brawler.name].sort().join(','), w, bt.rank); }
        continue;
      }
      if (!Array.isArray(teams) || teams.length !== 2 || teams.some(tm => tm.length !== 3)) continue;
      if (!bt.result || bt.result === 'draw') continue;
      const allTags = teams.flat().map(p => p.tag).sort().join(',');
      const key = it.battleTime + '|' + allTags; if (seen.has(key)) continue; seen.add(key);
      // o jogador dono do log é o que aparece em battle.result; achar o time dele
      const owner = log.__tag;
      let myTeam = teams.findIndex(tm => tm.some(p => p.tag === owner));
      if (myTeam < 0) continue;
      const win = bt.result === 'victory' ? myTeam : 1 - myTeam;
      const mode = MODE[it.event?.mode || bt.mode] || (it.event?.mode || bt.mode || 'other');
      const map = it.event?.id ? String(it.event.id) : null;
      const d = days[dayKey(t)] || (days[dayKey(t)] = emptyDay());
      const T = teams.map(tm => tm.map(p => p.brawler?.name).filter(Boolean));
      if (T.some(x => x.length !== 3)) continue;
      if (RANKED_TYPES.has(bt.type)) d.ranked++;
      if (map && it.event.map) d.mapNames[map] = [it.event.map, mode];
      addBattle(d, T, win, mode, map);
      const q = queueOf(bt, teams); if (q) addBattle(d.q[q], T, win, mode, map);
    }
  }
  return { t0, meta, days, brawlers, rot, players };
}

/* ------------- mescla com o estado ------------- */
function addSecs(a, b) { a.battles += b.battles || 0; for (const sec of SECS) { a[sec] = a[sec] || {}; for (const [kk, [g, w]] of Object.entries(b[sec] || {})) inc(a[sec], kk, g, w); } }
function addR(a, b) { for (const [k, [g, w, r]] of Object.entries(b || {})) { const x = a[k] || (a[k] = [0, 0, 0]); x[0] += g; x[1] += w; x[2] += r; } }
function addInto(a, b) { addSecs(a, b); a.q = a.q || emptyQs(); for (const k of QKEYS) { a.q[k] = a.q[k] || emptyQ(); if (b.q?.[k]) addSecs(a.q[k], b.q[k]); }
  a.sd = a.sd || {}; a.sdp = a.sdp || {}; addR(a.sd, b.sd); addR(a.sdp, b.sdp); }
async function mergeDays(days) {
  const dir = path.join(STATE_DIR, 'days');
  await fs.mkdir(dir, { recursive: true });
  for (const [k, d] of Object.entries(days)) {
    const f = path.join(dir, k + '.json');
    const old = await readJSON(f, emptyDay());
    addInto(old, d); old.ranked += d.ranked; Object.assign(old.mapNames, d.mapNames);
    await writeJSON(f, old);
  }
  // janela móvel
  const keep = new Set(Array.from({ length: WINDOW_DAYS }, (_, i) => dayKey(Date.now() - i * 864e5)));
  const all = {};
  for (const f of await fs.readdir(dir)) {
    const k = f.replace('.json', '');
    if (!keep.has(k)) { await fs.unlink(path.join(dir, f)); continue; }
    all[k] = await readJSON(path.join(dir, f), emptyDay());
  }
  const sum = emptyDay();
  for (const d of Object.values(all)) {
    addInto(sum, d); sum.ranked += d.ranked; Object.assign(sum.mapNames, d.mapNames);
  }
  return { sum, days: Object.keys(all).sort() };
}

/* ------------- estatística ------------- */
const shrink = (w, g, prior, k) => (w + prior * k) / (g + k);
const log5 = (a, b) => (a * (1 - b)) / (a * (1 - b) + b * (1 - a));

function compute(sum, brawlers, rot) {
  const teamSlots = sum.battles * 6;
  const WR = {};
  for (const [n, [g, w]] of Object.entries(sum.b)) WR[n] = shrink(w, g, 0.5, 30);
  const out = {};
  const MIN_PAIR = 12, MIN_MODE = 15;
  const get = n => out[n] || (out[n] = { g: 0, wr: null, pr: null, modes: {}, maps: {}, st: [], wk: [], mt: [] });
  for (const [n, [g, w]] of Object.entries(sum.b)) {
    const o = get(n); o.g = g; o.wr = +(WR[n] * 100).toFixed(1); o.pr = +((g / teamSlots) * 100).toFixed(2);
  }
  for (const [k, [g, w]] of Object.entries(sum.mode)) {
    if (g < MIN_MODE) continue; const [n, m] = k.split('|'); get(n).modes[m] = [g, +(shrink(w, g, WR[n] ?? .5, 20) * 100).toFixed(1)];
  }
  const vs = {};
  for (const [k, [g, w]] of Object.entries(sum.vs)) {
    if (g < MIN_PAIR) continue; const [a, b] = k.split('|'); const ex = log5(WR[a] ?? .5, WR[b] ?? .5);
    const adv = (shrink(w, g, ex, 20) - ex) * 100; (vs[a] || (vs[a] = [])).push([b, +adv.toFixed(1), g]);
  }
  const vsx = {};
  for (const [a, list] of Object.entries(vs)) {
    list.sort((x, y) => y[1] - x[1]);
    vsx[a] = list.filter(x => Math.abs(x[1]) >= 0.8).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 26).map(([b, p, g]) => [b, p, g]);
    get(a).st = list.filter(x => x[1] > 0).slice(0, 8);
    get(a).wk = list.filter(x => x[1] < 0).reverse().slice(0, 8).map(([b, p, g]) => [b, -p, g]);
  }
  const wi = {};
  for (const [k, [g, w]] of Object.entries(sum.with)) {
    if (g < MIN_PAIR) continue; const [a, b] = k.split('|'); const ex = ((WR[a] ?? .5) + (WR[b] ?? .5)) / 2;
    (wi[a] || (wi[a] = [])).push([b, +((shrink(w, g, ex, 20) - ex) * 100).toFixed(1), g]);
  }
  const wx = {};
  for (const [a, list] of Object.entries(wi)) { list.sort((x, y) => y[1] - x[1]); get(a).mt = list.filter(x => x[1] > 0).slice(0, 6); wx[a] = list.filter(x => Math.abs(x[1]) >= 0.8).slice(0, 20); }

  // por mapa
  const mapStats = {};
  for (const [k, [g, w]] of Object.entries(sum.map)) {
    if (g < 15) continue; const [n, m] = k.split('|');
    (mapStats[m] || (mapStats[m] = [])).push([n, +(shrink(w, g, WR[n] ?? .5, 15) * 100).toFixed(1), g]);
  }
  for (const l of Object.values(mapStats)) l.sort((a, b) => b[1] - a[1]);

  // melhores mapas de cada brawler: [mapId, win rate, partidas, modo]
  const byB = {};
  for (const [k, [g, w]] of Object.entries(sum.map)) {
    if (g < 12) continue; const [n, m] = k.split('|');
    (byB[n] || (byB[n] = [])).push([m, +(shrink(w, g, WR[n] ?? .5, 15) * 100).toFixed(1), g, sum.mapNames[m]?.[1] || '']);
  }
  for (const [n, l] of Object.entries(byB)) get(n).bm = l.sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const o of Object.values(out)) delete o.maps;

  // trios por modo
  const trios = {};
  for (const [k, [g, w]] of Object.entries(sum.trio)) {
    if (g < 6) continue; const [m, t] = k.split('|'); const T = t.split(',');
    const ex = T.reduce((s, n) => s + (WR[n] ?? .5), 0) / 3;
    (trios[m] || (trios[m] = [])).push({ t: T, wr: +(shrink(w, g, ex, 10) * 100).toFixed(1), ex: +(ex * 100).toFixed(1), g });
  }
  for (const m of Object.keys(trios)) trios[m] = trios[m].sort((a, b) => b.wr - a.wr).slice(0, 20);
  // trios por mapa
  const mapTrios = {};
  for (const [k, [g, w]] of Object.entries(sum.mtrio || {})) {
    if (g < 3) continue; const [m, t] = k.split('|'); const T = t.split(',');
    const ex = T.reduce((s, n) => s + (WR[n] ?? .5), 0) / 3;
    (mapTrios[m] || (mapTrios[m] = [])).push({ t: T, wr: +(shrink(w, g, ex, 8) * 100).toFixed(1), ex: +(ex * 100).toFixed(1), g });
  }
  for (const m of Object.keys(mapTrios)) mapTrios[m] = mapTrios[m].sort((a, b) => b.wr - a.wr).slice(0, 10);

  // partidas por mapa (pool real de cada fila)
  const mapGames = {};
  for (const [k, [g]] of Object.entries(sum.map)) { const m = k.split('|')[1]; mapGames[m] = (mapGames[m] || 0) + g; }
  // rotação atual
  const rotation = (rot || []).map(e => {
    const id = String(e.event?.id ?? ''); const mode = MODE[e.event?.mode] || e.event?.mode || 'other';
    return { start: e.startTime, end: e.endTime, mode, map: e.event?.map || sum.mapNames[id]?.[0] || '', mapId: id,
      top: (mapStats[id] || []).slice(0, 8) };
  }).filter(e => e.map);

  return { brawlers: out, trios, mapTrios, vsx, wx, battles: sum.battles, rotation, maps: Object.fromEntries(Object.entries(mapStats).map(([k, v]) => [k, { name: sum.mapNames[k]?.[0] || '', mode: sum.mapNames[k]?.[1] || '', g: Math.round((mapGames[k] || 0) / 6), top: v.slice(0, 10) }])), mapIndex: sum.mapNames, list: brawlers };
}

function showdown(sum) {
  const out = { SD: {}, DSD: {} }; const per = {};
  for (const [k, [g, w, r]] of Object.entries(sum.sd || {})) { const [m, n] = k.split('|'); (per[m] || (per[m] = [])).push([n, g, w, r]); }
  for (const [m, l] of Object.entries(per)) {
    const mode = sum.mapNames[m]?.[1]; if (!out[mode]) continue;
    const G = l.reduce((s, x) => s + x[1], 0), W = l.reduce((s, x) => s + x[2], 0), base = G ? W / G : .4;
    const top = l.filter(x => x[1] >= 5).map(([n, g, w, r]) => [n, +(shrink(w, g, base, 8) * 100).toFixed(1), g, +(r / g).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const duos = Object.entries(sum.sdp || {}).filter(([k, [g]]) => k.startsWith(m + '|') && g >= 3)
      .map(([k, [g, w, r]]) => [k.split('|')[1].split(','), +(shrink(w, g, base, 6) * 100).toFixed(1), g, +(r / g).toFixed(2)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    out[mode][m] = { name: sum.mapNames[m]?.[0] || '', g: G, base: +(base * 100).toFixed(1), top, ...(mode === 'DSD' ? { duos } : {}) };
  }
  return out;
}

/* ------------- execução ------------- */
(async () => {
  try {
    const { t0, meta, days, brawlers, rot, players } = await main();
    const { sum, days: dayList } = await mergeDays(days);
    const stats = compute(sum, brawlers, rot);
    // filas: casual e ranqueada acumulada por elo mínimo (r10 = Diamante+, ..., r22 = Pro)
    const queues = {}; const pack = qs => { const c = compute({ ...qs, mapNames: sum.mapNames }, brawlers, rot);
      return { battles: qs.battles, brawlers: c.brawlers, trios: c.trios, mapTrios: c.mapTrios, vsx: c.vsx, wx: c.wx, maps: Object.fromEntries(Object.entries(c.maps).map(([m, v]) => [m, { g: v.g, top: v.top }])) }; };
    queues.c = pack(sum.q.c);
    for (const b of BANDS) { const acc = emptyQ(); for (const x of BANDS) if (x >= b) addSecs(acc, sum.q['r' + x]); if (b <= 16) addSecs(acc, sum.q.r); queues['r' + b] = pack(acc); }
    queues.r = queues.r16;
    stats.queues = queues; stats.rankBands = BANDS;
    stats.showdown = showdown(sum);
    const out = {
      meta: { updated: new Date().toISOString(), windowDays: WINDOW_DAYS, days: dayList, battles: sum.battles,
        rankedBattles: sum.ranked, players: players.length, newBattles: Object.values(days).reduce((s, d) => s + d.battles, 0),
        countries: COUNTRIES, calls, failures, seconds: Math.round((Date.now() - t0) / 1000) },
      ...stats
    };
    await writeJSON(OUT_FILE, out);
    await writeJSON(path.join(STATE_DIR, 'meta.json'), { lastCutoff: t0, lastRun: new Date().toISOString() });
    console.log(`ok: ${out.meta.newBattles} partidas novas, ${sum.battles} na janela, ${calls} chamadas, ${failures} falhas`);
    if (players.length && failures > players.length * 0.5) { console.error('Muitas falhas na API.'); process.exit(2); }
  } catch (e) { console.error(e.message || e); process.exit(1); }
})();
