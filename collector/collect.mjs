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
const COUNTRIES = (process.env.COUNTRIES || 'global,BR,US,MX,ES').split(',').map(s => s.trim()).filter(Boolean);
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
function emptyDay() { return { battles: 0, ranked: 0, b: {}, mode: {}, map: {}, vs: {}, with: {}, trio: {}, mapNames: {} }; }
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
      d.battles++; if (RANKED_TYPES.has(bt.type)) d.ranked++;
      if (map && it.event.map) d.mapNames[map] = [it.event.map, mode];
      const T = teams.map(tm => tm.map(p => p.brawler?.name).filter(Boolean));
      if (T.some(x => x.length !== 3)) continue;
      T.forEach((tm, i) => {
        const w = i === win ? 1 : 0, enemy = T[1 - i];
        for (const n of tm) {
          inc(d.b, n, 1, w); inc(d.mode, n + '|' + mode, 1, w);
          if (map) inc(d.map, n + '|' + map, 1, w);
          for (const e of enemy) inc(d.vs, n + '|' + e, 1, w);
          for (const m of tm) if (m !== n) inc(d.with, n + '|' + m, 1, w);
        }
        inc(d.trio, mode + '|' + [...tm].sort().join(','), 1, w);
      });
    }
  }
  return { t0, meta, days, brawlers, rot, players };
}

/* ------------- mescla com o estado ------------- */
async function mergeDays(days) {
  const dir = path.join(STATE_DIR, 'days');
  await fs.mkdir(dir, { recursive: true });
  for (const [k, d] of Object.entries(days)) {
    const f = path.join(dir, k + '.json');
    const old = await readJSON(f, emptyDay());
    old.battles += d.battles; old.ranked += d.ranked;
    for (const sec of ['b', 'mode', 'map', 'vs', 'with', 'trio'])
      for (const [kk, [g, w]] of Object.entries(d[sec])) inc(old[sec], kk, g, w);
    Object.assign(old.mapNames, d.mapNames);
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
    sum.battles += d.battles; sum.ranked += d.ranked;
    for (const sec of ['b', 'mode', 'map', 'vs', 'with', 'trio'])
      for (const [kk, [g, w]] of Object.entries(d[sec])) inc(sum[sec], kk, g, w);
    Object.assign(sum.mapNames, d.mapNames);
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
  for (const [a, list] of Object.entries(vs)) {
    list.sort((x, y) => y[1] - x[1]);
    get(a).st = list.filter(x => x[1] > 0).slice(0, 8);
    get(a).wk = list.filter(x => x[1] < 0).reverse().slice(0, 8).map(([b, p, g]) => [b, -p, g]);
  }
  const wi = {};
  for (const [k, [g, w]] of Object.entries(sum.with)) {
    if (g < MIN_PAIR) continue; const [a, b] = k.split('|'); const ex = ((WR[a] ?? .5) + (WR[b] ?? .5)) / 2;
    (wi[a] || (wi[a] = [])).push([b, +((shrink(w, g, ex, 20) - ex) * 100).toFixed(1), g]);
  }
  for (const [a, list] of Object.entries(wi)) get(a).mt = list.sort((x, y) => y[1] - x[1]).filter(x => x[1] > 0).slice(0, 6);

  // por mapa
  const mapStats = {};
  for (const [k, [g, w]] of Object.entries(sum.map)) {
    if (g < 15) continue; const [n, m] = k.split('|');
    (mapStats[m] || (mapStats[m] = [])).push([n, +(shrink(w, g, WR[n] ?? .5, 15) * 100).toFixed(1), g]);
  }
  for (const l of Object.values(mapStats)) l.sort((a, b) => b[1] - a[1]);

  // trios por modo
  const trios = {};
  for (const [k, [g, w]] of Object.entries(sum.trio)) {
    if (g < 10) continue; const [m, t] = k.split('|'); const T = t.split(',');
    const ex = T.reduce((s, n) => s + (WR[n] ?? .5), 0) / 3;
    (trios[m] || (trios[m] = [])).push({ t: T, wr: +(shrink(w, g, ex, 10) * 100).toFixed(1), ex: +(ex * 100).toFixed(1), g });
  }
  for (const m of Object.keys(trios)) trios[m] = trios[m].sort((a, b) => b.wr - a.wr).slice(0, 15);

  // rotação atual
  const rotation = (rot || []).map(e => {
    const id = String(e.event?.id ?? ''); const mode = MODE[e.event?.mode] || e.event?.mode || 'other';
    return { start: e.startTime, end: e.endTime, mode, map: e.event?.map || sum.mapNames[id]?.[0] || '', mapId: id,
      top: (mapStats[id] || []).slice(0, 8) };
  }).filter(e => e.map);

  return { brawlers: out, trios, rotation, maps: Object.fromEntries(Object.entries(mapStats).map(([k, v]) => [k, { name: sum.mapNames[k]?.[0] || '', mode: sum.mapNames[k]?.[1] || '', top: v.slice(0, 10) }])), list: brawlers };
}

/* ------------- execução ------------- */
(async () => {
  try {
    const { t0, meta, days, brawlers, rot, players } = await main();
    const { sum, days: dayList } = await mergeDays(days);
    const stats = compute(sum, brawlers, rot);
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
