// Brawl Counter — metadados (sem chave de API).
// Junta, uma vez por dia:
//   • BrawlAPI (Brawlify): ids, fotos, acessórios e poderes de estrela de todos os brawlers, mapas e modos
//   • Brawl Stars Wiki (Fandom) em inglês, português e espanhol: nomes oficiais traduzidos dos itens
//   • Traduções oficiais de mapas e modos (as mesmas do jogo, publicadas pelo Brawl Time Ninja)
// Saída: OUT_META (padrão site/data/meta.json). Sem dependências: Node 20+.

const BAPI = 'https://api.brawlapi.com/v1';
const WIKI = { en: 'https://brawlstars.fandom.com/api.php', pt: 'https://brawlstars.fandom.com/pt/api.php', es: 'https://brawlstars.fandom.com/es/api.php' };
const TR = l => `https://media.brawltime.ninja/translations/${l}.json`;
const LANGS = ['en', 'pt', 'es'];
const UA = { 'User-Agent': 'BrawlCounter/1.0 (github.com/Om4rk77/brawl-counter)', Accept: 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) { console.warn('falhou', url, e.message); return null; } await sleep(700 * (i + 1)); }
  }
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = s => fold(s).replace(/[^a-z0-9]/g, '');

/* ---------- wiki ---------- */
function clean(t) {
  return String(t)
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '').replace(/'''?/g, '').replace(/\s+/g, ' ').trim();
}
function headings(w) {
  const out = []; const re = /^(={2,6})\s*(.*?)\s*\1\s*$/gm; let m;
  while ((m = re.exec(w))) out.push({ lv: m[1].length, raw: m[2], t: clean(m[2]) });
  return out;
}
const KEYS = {
  gd: { en: ['gadget'], pt: ['acessorio'], es: ['gadget', 'artilugio'] },
  sp: { en: ['star power'], pt: ['poder de estrela', 'poderes de estrela', 'poder estelar', 'poderes estelares'], es: ['habilidad estelar', 'habilidades estelares', 'poder estelar'] },
  hc: { en: ['hypercharge'], pt: ['hipercarga'], es: ['hipercarga'] },
};
const ALT = { pt: { 'Mr. P': 'Sr. P', 'Larry & Lawrie': 'Larry e Lawrie' }, es: { 'Larry & Lawrie': 'Larry y Lawrie' } };
const SKIP = /buffie|hyper ?charge|hipercarga|^estat|^stat|^skin|^aspect/i;
function section(H, keys, kind) {
  const i = H.findIndex(h => keys.some(k => fold(h.t).startsWith(k)));
  if (i < 0) return [];
  const L = H[i].lv; const names = [];
  if (kind === 'hc' && H[i].t.includes(':')) names.push(H[i].t.split(':').slice(1).join(':').split('/')[0].trim());
  for (let j = i + 1; j < H.length && H[j].lv > L; j++) {
    const t = H[j].t.replace(/^\d+\s*/, '').split('/')[0].trim();
    if (t && !SKIP.test(t) && H[j].lv === L + 1) names.push(t);
  }
  return names.filter(Boolean);
}
async function wikiPage(lang, title) {
  const u = `${WIKI[lang]}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext${lang === 'en' ? '|langlinks' : ''}&redirects=1&format=json&origin=*`;
  const j = await get(u); if (!j || !j.parse) return null;
  return { w: j.parse.wikitext['*'], ll: Object.fromEntries((j.parse.langlinks || []).map(l => [l.lang, l['*']])) };
}
async function wikiItems(name) {
  const res = {};
  const en = await wikiPage('en', name); if (!en) return null;
  for (const lang of LANGS) {
    let p = en;
    if (lang !== 'en') {
      const tries = [...new Set([en.ll[lang], ALT[lang]?.[name], name, name.replace(' & ', ' e ').replace(' & ', ' y ')].filter(Boolean))];
      p = null; for (const t of tries) { p = await wikiPage(lang, t); if (p) break; }
    }
    if (!p) continue;
    const H = headings(p.w);
    res[lang] = { gd: section(H, KEYS.gd[lang], 'gd'), sp: section(H, KEYS.sp[lang], 'sp'), hc: section(H, KEYS.hc[lang], 'hc') };
  }
  return res;
}
// alinha os nomes da wiki (em ordem) com os itens oficiais (nome em inglês + id)
function align(official, wiki, kind) {
  const enList = wiki?.en?.[kind] || [];
  return official.map((it, idx) => {
    let k = enList.findIndex(n => norm(n) === norm(it.name));
    if (k < 0 && enList.length === official.length) k = idx;
    const n = { en: it.name };
    for (const l of ['pt', 'es']) { const v = k >= 0 ? wiki?.[l]?.[kind]?.[k] : null; n[l] = v && v.length < 40 ? v : it.name; }
    return { id: it.id, n };
  });
}

/* ---------- principal ---------- */
export async function buildMeta(log = console.log) {
  const t0 = Date.now();
  const [bl, ml, gl, ...tr] = await Promise.all([get(BAPI + '/brawlers'), get(BAPI + '/maps'), get(BAPI + '/gamemodes'), ...LANGS.map(l => get(TR(l)))]);
  if (!bl?.list) throw new Error('BrawlAPI indisponível');
  const T = Object.fromEntries(LANGS.map((l, i) => [l, tr[i] || {}]));
  const list = bl.list.filter(b => b.released !== false).sort((a, b) => a.id - b.id);
  log(`brawlers: ${list.length}`);

  const wiki = await pool(list, 4, async b => { const r = await wikiItems(b.name); await sleep(150); return r; });
  const brawlers = {};
  let okItems = 0;
  list.forEach((b, i) => {
    const w = wiki[i];
    const gd = align([...(b.gadgets || [])].sort((x, y) => x.id - y.id), w, 'gd');
    const sp = align([...(b.starPowers || [])].sort((x, y) => x.id - y.id), w, 'sp');
    const hcEn = w?.en?.hc?.[0] || null;
    const hc = hcEn ? { n: { en: hcEn, pt: w?.pt?.hc?.[0] || hcEn, es: w?.es?.hc?.[0] || hcEn } } : null;
    if (w) okItems++;
    brawlers[b.name] = { id: b.id, cls: b.class?.name || '', rar: b.rarity?.name || '', gd, sp, hc };
  });
  log(`itens traduzidos para ${okItems}/${list.length} brawlers`);

  const modes = {};
  for (const g of gl?.list || []) {
    const key = g.scHash || g.hash;
    modes[key] = { id: g.id, color: g.color || '', n: Object.fromEntries(LANGS.map(l => [l, T[l]['mode.' + key] || g.name])) };
  }
  const maps = {};
  for (const m of ml?.list || []) {
    const has = T.en['map.' + m.id];
    if (m.disabled && !has) continue;
    maps[m.id] = { m: m.gameMode?.scHash || m.gameMode?.hash || '', d: m.disabled ? 1 : 0, n: Object.fromEntries(LANGS.map(l => [l, T[l]['map.' + m.id] || m.name])) };
  }
  log(`mapas: ${Object.keys(maps).length}, modos: ${Object.keys(modes).length}`);
  return { updated: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), brawlers, modes, maps };
}

/* ---------- execução em Node ---------- */
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fs = await import('node:fs/promises');
  const OUT = process.env.OUT_META || 'site/data/meta.json';
  const MAX_AGE_H = +(process.env.META_MAX_AGE_H || 20);
  try {
    const old = JSON.parse(await fs.readFile(OUT, 'utf8'));
    if (Date.now() - new Date(old.updated) < MAX_AGE_H * 36e5 && !process.env.FORCE_META) { console.log('meta.json recente, mantido'); process.exit(0); }
  } catch {}
  try {
    const meta = await buildMeta();
    await fs.mkdir(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(meta));
    console.log('meta.json ok em', meta.seconds, 's');
  } catch (e) { console.error(e.message || e); process.exit(1); }
}
