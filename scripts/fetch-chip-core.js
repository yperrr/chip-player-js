// Rafraichit le coeur wasm vendorise depuis le build publie par chiptune.app.
//
// OUTIL MANUEL. Il n'est JAMAIS appele pendant la construction : le resultat
// est commite. La construction ne doit dependre ni du reseau ni de ce qu'un
// tiers publie aujourd'hui — sans quoi deux images baties du meme commit
// pourraient differer.
//
// POURQUOI PASSER PAR LE SOURCEMAP
//
// Le fichier servi sous le nom « chip-core.js » n'est pas la colle emscripten :
// c'est un chunk webpack, qui depend du runtime de SON build et n'est donc pas
// reutilisable. Le sourcemap voisin, lui, contient la source d'origine intacte
// dans sourcesContent[0] — sortie vierge d'emscripten, `export default
// CHIP_CORE`, avec la reference `new URL("chip-core.wasm", import.meta.url)`
// que webpack 5 sait resoudre en actif. C'est elle qu'on reprend.
//
// REGLE ABSOLUE : la colle et le .wasm viennent du MEME manifeste. Les exports
// du wasm sont minifies en lettres et c'est la colle qui les mappe ; melanger
// deux builds produit une casse silencieuse d'abord, brutale ensuite.
//
// Apres rafraichissement, toujours lancer `node scripts/verify-wasm-abi.js`
// puis la matrice de formats : un controle de symboles ne voit pas une derive
// de comportement.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.CHIP_CORE_SOURCE || 'https://chiptune.app';
const RACINE = path.resolve(__dirname, '..');

// Cloudflare refuse les agents par defaut de certains clients ; on se declare.
const ENTETES = { 'User-Agent': 'chip-player-js/fetch-chip-core' };

async function recuperer(url, binaire = false) {
  const r = await fetch(url, { headers: ENTETES });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return binaire ? Buffer.from(await r.arrayBuffer()) : await r.text();
}

(async () => {
  const manifeste = JSON.parse(await recuperer(`${BASE}/asset-manifest.json`));
  const fichiers = manifeste.files || manifeste;

  const urlMap = Object.entries(fichiers)
    .find(([cle]) => cle.includes('chip-core') && cle.endsWith('.map'))?.[1];
  const urlWasm = Object.entries(fichiers)
    .find(([, val]) => String(val).includes('chip-core') && String(val).endsWith('.wasm'))?.[1];
  if (!urlMap || !urlWasm) throw new Error('manifeste : chip-core introuvable');

  console.log('source    : %s', BASE);
  console.log('sourcemap : %s', urlMap);
  console.log('wasm      : %s', urlWasm);

  const smap = JSON.parse(await recuperer(BASE + urlMap));
  const colle = smap.sourcesContent && smap.sourcesContent[0];
  if (!colle || !colle.includes('export default CHIP_CORE')) {
    throw new Error('la source extraite n\'est pas la colle emscripten attendue');
  }

  const wasm = await recuperer(BASE + urlWasm, true);
  if (wasm.subarray(0, 4).toString('binary') !== '\0asm') {
    throw new Error('le fichier recupere n\'a pas la magie wasm');
  }

  fs.writeFileSync(path.join(RACINE, 'src', 'chip-core.js'), colle);
  fs.writeFileSync(path.join(RACINE, 'src', 'chip-core.wasm'), wasm);

  const sha = d => crypto.createHash('sha256').update(d).digest('hex');
  const provenance = {
    source: BASE,
    manifeste: `${BASE}/asset-manifest.json`,
    chunkPublie: fichiers['chip-core.js'] ? BASE + fichiers['chip-core.js'] : null,
    recupereLe: new Date().toISOString().slice(0, 10),
    colle: { url: BASE + urlMap, octets: Buffer.byteLength(colle), sha256: sha(colle) },
    wasm: { url: BASE + urlWasm, octets: wasm.length, sha256: sha(wasm) },
  };
  fs.writeFileSync(path.join(RACINE, 'src', 'chip-core.provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n');

  console.log('\ncolle : %d octets', provenance.colle.octets);
  console.log('wasm  : %d octets', provenance.wasm.octets);
  console.log('\nVerifier maintenant : node scripts/verify-wasm-abi.js');
})().catch(e => {
  console.error('Rafraichissement impossible :', e.message);
  process.exit(1);
});
