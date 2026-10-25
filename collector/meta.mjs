// Brawl Counter — metadados (sem chave de API), renovados 1x por dia.
// Fontes, em ordem de prioridade:
//   1) Dados do jogo publicados pela Brawlify (api-static): nomes oficiais em inglês, português e
//      espanhol de brawlers, acessórios, poderes de estrela, hipercargas, engrenagens, classes,
//      raridades, mapas e modos.
//   2) BrawlAPI (Brawlify): lista sempre atualizada de brawlers (inclui os recém-lançados), ids e imagens.
//   3) Brawl Stars Wiki (Fandom) em espanhol e português: reserva para nomes de itens novos.
// Saída: OUT_META (padrão site/data/meta.json). Sem dependências: Node 20+.

const BAPI = 'https://api.brawlapi.com/v1';
const GAME = 'https://api-static.brawlify.com/v1/game';
// arquivos de dados do jogo por idioma (nomes com hash; atualizados quando o jogo muda)
const GAME_FILES = {
  en: { bf: 'brawlers-full.1610422c', maps: 'maps.4ec7992f', modes: 'modes.f030f179', misc: 'misc.3c8713a0' },
  pt: { bf: 'brawlers-full.0542130e', maps: 'maps.6761ffa4', modes: 'modes.e7fdfa61', misc: 'misc.5ae2add3' },
  es: { bf: 'brawlers-full.88f2dafd', maps: 'maps.f61efde3', modes: 'modes.94479826', misc: 'misc.3a41b41f' },
};
const WIKI = { en: 'https://brawlstars.fandom.com/api.php', pt: 'https://brawlstars.fandom.com/pt/api.php', es: 'https://brawlstars.fandom.com/es/api.php' };
const LANGS = ['en', 'pt', 'es'];
const HDR = { 'User-Agent': 'Mozilla/5.0 (compatible; BrawlCounter/1.0; +https://github.com/Om4rk77/brawl-counter)', Accept: 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.status === 404 || r.status === 403) { console.warn('indisponível', r.status, url); return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) { console.warn('falhou', url, e.message); return null; } await sleep(700 * (i + 1)); }
  }
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = s => fold(s).replace(/[^a-z0-9]/g, '');

/* ---------- nomes do jogo vêm em MAIÚSCULAS: deixa em formato de título ---------- */
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'del', 'la', 'el', 'y', 'los', 'las', 'of', 'the', 'a', 'o', 'en', 'em', 'no', 'na', 'to', 'and', 'with', 'com', 'con', 'por', 'for', 'in', 'al', 'at', 'on', 'du', 'au']);
function title(s) {
  return String(s || '').toLowerCase().split(/(\s+|-)/)
    .map((w, i) => (i > 0 && SMALL.has(w)) ? w : w.replace(/^(\p{L})/u, c => c.toUpperCase()))
    .join('').replace(/\b(Ii|Iii|Iv|Vi)\b/g, m => m.toUpperCase());
}
const L3 = f => Object.fromEntries(LANGS.map(l => [l, f(l)]));

/* ---------- wiki (reserva) ---------- */
function clean(t) { return String(t).replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/<[^>]+>/g, '').replace(/'''?/g, '').replace(/\s+/g, ' ').trim(); }
function headings(w) { const out = []; const re = /^(={2,6})\s*(.*?)\s*\1\s*$/gm; let m; while ((m = re.exec(w))) out.push({ lv: m[1].length, t: clean(m[2]) }); return out; }
const KEYS = { gd: { en: ['gadget'], pt: ['acessorio'], es: ['gadget'] }, sp: { en: ['star power'], pt: ['poder de estrela', 'poderes de estrela'], es: ['habilidad estelar', 'habilidades estelares'] }, hc: { en: ['hypercharge'], pt: ['hipercarga'], es: ['hipercarga'] } };
const SKIP = /buffie|hyper ?charge|hipercarga|^estat|^stat|^skin|^aspect/i;
function section(H, keys, kind) {
  const i = H.findIndex(h => keys.some(k => fold(h.t).startsWith(k))); if (i < 0) return [];
  const L = H[i].lv; const names = [];
  if (kind === 'hc' && H[i].t.includes(':')) names.push(H[i].t.split(':').slice(1).join(':').split('/')[0].trim());
  for (let j = i + 1; j < H.length && H[j].lv > L; j++) { const t = H[j].t.split('/')[0].trim(); if (t && !SKIP.test(t) && H[j].lv === L + 1 && t.length < 40) names.push(t); }
  return names;
}
async function wikiItems(name) {
  const page = async (lang, t) => { const j = await get(`${WIKI[lang]}?action=parse&page=${encodeURIComponent(t)}&prop=wikitext${lang === 'en' ? '|langlinks' : ''}&redirects=1&format=json&origin=*`, 2); return j?.parse ? { w: j.parse.wikitext['*'], ll: Object.fromEntries((j.parse.langlinks || []).map(l => [l.lang, l['*']])) } : null; };
  const en = await page('en', name); if (!en) return null;
  const res = {};
  for (const lang of LANGS) {
    const p = lang === 'en' ? en : await page(lang, en.ll[lang] || name); if (!p) continue;
    const H = headings(p.w); res[lang] = { gd: section(H, KEYS.gd[lang], 'gd'), sp: section(H, KEYS.sp[lang], 'sp'), hc: section(H, KEYS.hc[lang], 'hc') };
  }
  return res;
}

/* ---------- principal ---------- */
export async function buildMeta(log = console.log) {
  const t0 = Date.now();
  const game = {};
  await Promise.all(LANGS.map(async l => {
    game[l] = {};
    await Promise.all(Object.entries(GAME_FILES[l]).map(async ([k, f]) => { game[l][k] = (await get(`${GAME}/${l}/${f}.json`))?.data || null; }));
  }));
  const okGame = LANGS.every(l => game[l].bf && game[l].misc);
  log(`dados do jogo (Brawlify): ${okGame ? 'ok' : 'indisponíveis — usando reservas'}`);
  const G = l => Object.fromEntries((game[l].bf?.brawlers || []).map(b => [b.id, b]));
  const GB = L3(G);

  const bl = await get(BAPI + '/brawlers');
  const list = (bl?.list || []).filter(b => b.released !== false).sort((a, b) => a.id - b.id);
  // se a BrawlAPI falhar, usa a lista dos dados do jogo
  const ids = list.length ? list.map(b => b.id) : Object.keys(GB.en).map(Number).sort((a, b) => a - b);
  log(`brawlers: ${ids.length}`);

  // itens que os dados do jogo não cobrem (brawler novo): tenta a wiki
  const needWiki = ids.filter(id => !GB.pt[id] || !GB.es[id]);
  const wiki = {};
  await pool(needWiki, 3, async id => { const n = list.find(b => b.id === id)?.name || GB.en[id]?.name; if (n) wiki[id] = await wikiItems(title(n)); await sleep(150); });
  if (needWiki.length) log(`wiki consultada para ${needWiki.length} brawler(s) novo(s)`);

  const brawlers = {};
  for (const id of ids) {
    const api = list.find(b => b.id === id); const g = L3(l => GB[l][id]);
    const enName = api?.name || title(g.en?.name);
    const items = (kind, apiKind) => {
      const base = (g.en?.[kind] || api?.[apiKind] || []).map(x => ({ id: x.id, en: x.name }));
      return base.map((x, idx) => ({
        id: x.id,
        n: L3(l => {
          const own = g[l]?.[kind]?.find(y => y.id === x.id)?.name;
          if (own) return title(own);
          const w = wiki[id]?.[l]?.[kind === 'gadgets' ? 'gd' : 'sp']?.[idx];
          return w || (l === 'en' ? title(x.en) : title(x.en));
        }),
      }));
    };
    const hcSrc = g.en?.hypercharge;
    const hc = hcSrc ? { id: hcSrc.id, n: L3(l => title(g[l]?.hypercharge?.name || hcSrc.name)) }
      : (wiki[id]?.en?.hc?.[0] ? { id: null, n: L3(l => wiki[id]?.[l]?.hc?.[0] || wiki[id].en.hc[0]) } : null);
    brawlers[enName] = {
      id, c: g.en?.classId ?? null, r: g.en?.rarityId ?? null,
      n: L3(l => g[l]?.name ? title(g[l].name) : enName),
      gd: items('gadgets', 'gadgets'), sp: items('starPowers', 'starPowers'), hc,
    };
  }

  const pick = (kind, sub) => L3(l => Object.fromEntries((game[l][kind]?.[sub] || []).map(x => [x.id, x])));
  const misc = k => { const out = {}; for (const x of game.en.misc?.[k] || []) out[x.id] = { n: L3(l => title((game[l].misc?.[k] || []).find(y => y.id === x.id)?.name || x.name)), color: x.color || undefined }; return out; };
  const MP = pick('maps', 'maps'), MD = pick('modes', 'modes');
  const maps = {}; for (const [id, m] of Object.entries(MP.en)) maps[id] = { n: L3(l => title(MP[l][id]?.name || m.name)), mode: m.modeId, ...(m.disabled ? { x: 1 } : {}) };
  const modes = {}; for (const [id, m] of Object.entries(MD.en)) modes[id] = { n: L3(l => title(MD[l][id]?.name || m.name)), hash: m.hash, color: m.color };
  // mapas novos que só a BrawlAPI conhece (nome em inglês)
  if (Object.keys(maps).length < 50) {
    const ml = await get(BAPI + '/maps');
    for (const m of ml?.list || []) if (!maps[m.id]) maps[m.id] = { n: L3(() => m.name), mode: m.gameMode?.id || null };
  }
  const out = {
    updated: new Date().toISOString(), seconds: 0,
    brawlers, maps, modes, gears: misc('gears'), classes: misc('classes'), rarities: misc('rarities'),
  };
  out.seconds = Math.round((Date.now() - t0) / 1000);
  let tr = 0, tot = 0; for (const b of Object.values(brawlers)) for (const x of [...b.gd, ...b.sp, ...(b.hc ? [b.hc] : [])]) { tot++; if (x.n.pt !== x.n.en || x.n.es !== x.n.en) tr++; }
  log(`itens: ${tr}/${tot} traduzidos · mapas: ${Object.keys(maps).length} · modos: ${Object.keys(modes).length} · engrenagens: ${Object.keys(out.gears).length}`);
  return out;
}

/* ---------- execução em Node ---------- */
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fs = await import('node:fs/promises');
  const OUT = process.env.OUT_META || 'site/data/meta.json';
  const MAX_AGE_H = +(process.env.META_MAX_AGE_H || 20);
  let old = null;
  try { old = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  if (old?.v === 3 && Date.now() - new Date(old.updated) < MAX_AGE_H * 36e5 && !process.env.FORCE_META) { console.log('meta.json recente, mantido'); process.exit(0); }
  try {
    const meta = await buildMeta(); meta.v = 3;
    if (!Object.keys(meta.brawlers).length) throw new Error('nenhum brawler — mantendo o arquivo anterior');
    await fs.mkdir(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(meta));
    console.log('meta.json ok em', meta.seconds, 's');
  } catch (e) { console.error(e.message || e); process.exit(1); }
}
