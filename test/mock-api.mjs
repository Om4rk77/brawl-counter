// API falsa do Brawl Stars para testar o coletor sem chave.
// Gera partidas aleatórias com um viés conhecido: BOLT vence SPROUT com frequência.
import http from 'node:http';
import fs from 'node:fs';

const statics = JSON.parse(fs.readFileSync(new URL('../site/data/static.json', import.meta.url))).brawlers;
const NAMES = statics.map(b => b.n.toUpperCase());
const now = Date.now();
const modes = [['gemGrab', 15000007, 'Gem Fort'], ['brawlBall', 15000008, 'Center Stage'], ['knockout', 15000009, 'New Horizons'], ['hotZone', 15000010, 'Ring of Fire']];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)];
const bt = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '.000Z');
const players = Array.from({ length: 80 }, (_, i) => '#P' + (1000 + i));
const logs = {};
for (const tag of players) {
  logs[tag] = { items: Array.from({ length: 25 }, (_, k) => {
    const [mode, id, map] = pick(modes);
    const team = () => { const s = new Set(); while (s.size < 3) s.add(pick(NAMES)); return [...s]; };
    let A = team(), B = team();
    if (k % 3 === 0) { A[0] = 'BOLT'; B[0] = 'SPROUT'; }
    const others = Array.from({ length: 5 }, () => '#X' + Math.floor(rnd() * 1e6));
    const mk = (names, tags) => names.map((n, i) => ({ tag: tags[i], name: 'p', brawler: { id: 16000000 + (statics.find(s => s.n.toUpperCase() === n)?.id || 0), name: n, power: 11, trophies: 1000 } }));
    const tA = [tag, others[0], others[1]], tB = [others[2], others[3], others[4]];
    let pWin = 0.5; if (A.includes('BOLT') && B.includes('SPROUT')) pWin = 0.8;
    const result = rnd() < pWin ? 'victory' : 'defeat';
    return { battleTime: bt(now - (k * 20 + Math.floor(rnd() * 10)) * 60000), event: { id, mode, map },
      battle: { mode, type: k % 2 ? 'soloRanked' : 'ranked', result, duration: 120, teams: [mk(A, tA), mk(B, tB)] } };
  }) };
}
const routes = {
  '/v1/brawlers': () => ({ items: statics.map(s => ({ id: 16000000 + s.id, name: s.n.toUpperCase(), gadgets: [], starPowers: [] })).concat([{ id: 16000111, name: 'NOVO BRAWLER', gadgets: [], starPowers: [] }]) }),
  '/v1/events/rotation': () => modes.map(([mode, id, map]) => ({ startTime: bt(now - 3600e3), endTime: bt(now + 5 * 3600e3), slotId: 1, event: { id, mode, map } })),
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body;
  if (req.headers.authorization !== 'Bearer TESTE') { res.writeHead(403); return res.end('{"reason":"accessDenied"}'); }
  if (routes[u.pathname]) body = routes[u.pathname]();
  else if (/\/v1\/rankings\/[^/]+\/players/.test(u.pathname)) body = { items: players.slice(0, 40 + (u.pathname.includes('BR') ? 40 : 0)).map((tag, i) => ({ tag, rank: i + 1 })) };
  else { const m = /\/v1\/players\/(.+)\/battlelog/.exec(u.pathname); if (m) body = logs[decodeURIComponent(m[1])]; }
  if (!body) { res.writeHead(404); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}).listen(9911, () => console.log('mock em :9911'));
