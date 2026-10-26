// Brawl Counter — dados do cenário competitivo (Liquipedia, CC BY-SA 3.0).
// Lê as páginas do Brawl Stars Championship do ano, junta picks, bans e placar
// de cada mapa e gera site/data/pro.json. Roda no máximo 1x a cada 20h.
//
// Uso: node collector/pro.mjs   (OUT_PRO, PRO_YEAR, PRO_DAYS, FORCE_PRO opcionais)
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_PRO || 'site/data/pro.json';
const YEAR = process.env.PRO_YEAR || String(new Date().getUTCFullYear());
const DAYS = +(process.env.PRO_DAYS || 120);
const API = 'https://liquipedia.net/brawlstars/api.php';
const UA = 'BrawlCounter/1.0 (https://github.com/Om4rk77/brawl-counter; fan site)';
const MODE = { 'gem grab': 'GG', 'brawl ball': 'BB', 'knockout': 'KO', 'hot zone': 'HZ', 'heist': 'HE', 'bounty': 'BO',
  'wipeout': 'WO', 'brawl hockey': 'HK', 'siege': 'SI' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(params) {
  const u = API + '?format=json&' + new URLSearchParams(params);
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } });
      if (r.ok) return await r.json();
      await sleep(4000 * (i + 1));
    } catch { await sleep(4000 * (i + 1)); }
  }
  return null;
}

function parse(title, w) {
  const out = [];
  const re = /\|map\d+=\{\{Map([\s\S]*?)\n\s*\}\}/g; let m;
  while ((m = re.exec(w))) {
    const b = m[1], f = k => (new RegExp('\\|' + k + '=([^|\\n]*)').exec(b)?.[1] || '').trim();
    const t1 = [1, 2, 3].map(i => f('t1c' + i)).filter(Boolean), t2 = [1, 2, 3].map(i => f('t2c' + i)).filter(Boolean);
    if (t1.length !== 3 || t2.length !== 3) continue;
    const s1 = +f('score1'), s2 = +f('score2'); if (!(s1 >= 0 && s2 >= 0) || s1 === s2) continue;
    const mode = MODE[f('maptype').toLowerCase()]; if (!mode) continue;
    const before = w.slice(0, m.index);
    const date = (before.match(/date=(\d{4}-\d{2}-\d{2})/g) || []).pop()?.slice(5) || '';
    const opp = n => (before.match(new RegExp('opponent' + n + '=\\{\\{TeamOpponent\\|([^|}]+)', 'g')) || []).pop()?.split('|').pop() || '';
    out.push({ ev: title.replace(/^Brawl Stars Championship\/\d+\//, ''), date, map: f('map'), mode, t: [t1, t2],
      bans: [[1, 2, 3].map(i => f('t1b' + i)).filter(Boolean), [1, 2, 3].map(i => f('t2b' + i)).filter(Boolean)],
      win: s1 > s2 ? 0 : 1, teams: [opp(1), opp(2)] });
  }
  return out;
}

(async () => {
  const old = await fs.readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
  if (old && Date.now() - new Date(old.updated) < 20 * 36e5 && !process.env.FORCE_PRO) { console.log('pro.json recente, mantido'); return; }
  const titles = []; let cont = {};
  do {
    const j = await get({ action: 'query', list: 'allpages', apnamespace: 0, aplimit: 500, apprefix: `Brawl Stars Championship/${YEAR}/`, ...cont });
    if (!j) break; titles.push(...j.query.allpages.map(p => p.title)); cont = j.continue ? { apcontinue: j.continue.apcontinue } : null;
    await sleep(2500);
  } while (cont);
  let games = [];
  for (let i = 0; i < titles.length; i += 50) {
    const j = await get({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
    for (const p of Object.values(j?.query?.pages || {})) games.push(...parse(p.title, p.revisions?.[0]?.slots?.main?.['*'] || ''));
    await sleep(2500);
  }
  const today = new Date().toISOString().slice(0, 10);
  games = games.filter(g => g.date && g.date <= today);
  if (!games.length) { console.warn('nenhum jogo competitivo encontrado'); if (!old) await fs.writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), games: 0, modes: {} })); return; }
  const last = games.map(g => g.date).sort().pop();
  const from = new Date(Date.parse(last) - DAYS * 864e5).toISOString().slice(0, 10);
  games = games.filter(g => g.date >= from);

  const key = t => [...t].sort().join(',');
  const modes = {};
  for (const g of games) {
    const M = modes[g.mode] || (modes[g.mode] = { games: 0, comps: {}, picks: {}, bans: {}, maps: {}, pairs: {}, perMap: {}, recent: [] });
    M.recent.push({ d: g.date, ev: g.ev, map: g.map, t: g.t, win: g.win, teams: g.teams });
    M.games++; M.maps[g.map] = (M.maps[g.map] || 0) + 1;
    g.t.forEach((t, i) => {
      const k = key(t), w = g.win === i ? 1 : 0, ek = key(g.t[1 - i]);
      const c = M.comps[k] || (M.comps[k] = { t: [...t].sort(), n: 0, w: 0, maps: {}, teams: {}, beat: {}, lost: {} });
      c.n++; c.w += w; c.maps[g.map] = (c.maps[g.map] || 0) + 1; if (g.teams[i]) c.teams[g.teams[i]] = (c.teams[g.teams[i]] || 0) + 1;
      (w ? c.beat : c.lost)[ek] = ((w ? c.beat : c.lost)[ek] || 0) + 1;
      for (const b of t) { const p = M.picks[b] || (M.picks[b] = [0, 0]); p[0]++; p[1] += w; }
      const st = [...t].sort(); for (let a = 0; a < 3; a++) for (let z = a + 1; z < 3; z++) { const pk = st[a] + ',' + st[z]; const q = M.pairs[pk] || (M.pairs[pk] = [0, 0]); q[0]++; q[1] += w; }
      const pm = M.perMap[g.map] || (M.perMap[g.map] = {}); const pc = pm[k] || (pm[k] = [0, 0]); pc[0]++; pc[1] += w;
    });
    for (const side of g.bans) for (const b of side) M.bans[b] = (M.bans[b] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const outModes = {};
  for (const [m, M] of Object.entries(modes)) {
    const comps = Object.values(M.comps).sort((a, b) => b.n - a.n || b.w - a.w).slice(0, 12).map(c => ({
      t: c.t, n: c.n, w: c.w, maps: top(c.maps, 4), teams: top(c.teams, 4).map(x => x[0]),
      lost: top(c.lost, 4).map(([k, n]) => [k.split(','), n]), beat: top(c.beat, 4).map(([k, n]) => [k.split(','), n]) }));
    const pairs = Object.entries(M.pairs).filter(([, [n]]) => n >= 3).sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(([k, [n, w]]) => [k.split(','), n, w]);
    const perMap = Object.fromEntries(top(M.maps, 12).map(([mp]) => [mp, Object.entries(M.perMap[mp]).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, 3).map(([k, [n, w]]) => [k.split(','), n, w])]));
    const recent = M.recent.sort((a, b) => b.d.localeCompare(a.d)).slice(0, 8);
    outModes[m] = { games: M.games, comps, pairs, perMap, recent, maps: top(M.maps, 12),
      picks: top(Object.fromEntries(Object.entries(M.picks).map(([b, [n, w]]) => [b, n])), 14).map(([b, n]) => [b, n, M.picks[b][1]]),
      bans: top(M.bans, 10) };
  }
  const out = { updated: new Date().toISOString(), source: 'Liquipedia (CC BY-SA 3.0)', from, to: last, games: games.length,
    events: [...new Set(games.map(g => g.ev))].length, modes: outModes };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out));
  console.log(`pro.json: ${games.length} jogos (${from} a ${last}), ${Object.keys(outModes).length} modos`);
})();
