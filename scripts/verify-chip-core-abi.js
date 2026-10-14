// Verifie que le coeur wasm vendorise expose bien tout ce que src/ lui demande.
//
// POURQUOI CE SCRIPT EXISTE
//
// Ce fork ne recompile pas chip-core : il embarque la colle et le .wasm publies
// par chiptune.app (voir src/chip-core.provenance.json). Le code JavaScript,
// lui, continue de suivre l'amont. Rien n'empeche donc un commit amont
// d'appeler une fonction native ajoutee APRES le build qu'on embarque.
//
// Ce desaccord ne se verrait pas a la construction : webpack ne sait rien des
// symboles du wasm. Il se manifesterait a l'execution, sur un format
// particulier, par un « ... is not a function » au moment de lire un fichier —
// c'est-a-dire tard, et chez l'utilisateur.
//
// On le detecte donc ici, avant webpack. Un symbole manquant arrete la
// construction au lieu de livrer une image dont une fonctionnalite est morte
// en silence.
//
// Le correctif, le cas echeant : rafraichir le couple avec
// `node scripts/fetch-chip-core.js`, qui va chercher un build plus recent.
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const COLLE = path.join(RACINE, 'src', 'chip-core.js');
const SOURCES = path.join(RACINE, 'src');

// La colle declare ses exports de deux facons : la table publique
// Module["_x"], et des liaisons directes `var _x = wasmExports[...]` pour ce
// qu'elle appelle elle-meme. Les deux comptent.
function exportsDeLaColle(texte) {
  const trouves = new Set();
  for (const m of texte.matchAll(/Module\["(_[A-Za-z0-9_]+)"\]/g)) trouves.add(m[1]);
  for (const m of texte.matchAll(/\b(_[A-Za-z0-9_]+)\s*=\s*wasmExports\[/g)) trouves.add(m[1]);
  return trouves;
}

// Appels de la forme core._x, chipCore._x, this.core._x — c'est ainsi que les
// lecteurs atteignent le natif.
function symbolesUtilises(dossier) {
  const utilises = new Map();   // symbole -> fichiers
  (function parcourir(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { parcourir(p); continue; }
      if (!e.name.endsWith('.js') || p === COLLE) continue;
      const texte = fs.readFileSync(p, 'utf-8');
      for (const m of texte.matchAll(/\b(?:this\.)?(?:core|chipCore)\.(_[A-Za-z0-9_]+)/g)) {
        const rel = path.relative(RACINE, p).replace(/\\/g, '/');
        if (!utilises.has(m[1])) utilises.set(m[1], new Set());
        utilises.get(m[1]).add(rel);
      }
    }
  })(dossier);
  return utilises;
}

if (!fs.existsSync(COLLE)) {
  console.error('ABI : %s est absent. Lancer `node scripts/fetch-chip-core.js`.', COLLE);
  process.exit(1);
}

const exportes = exportsDeLaColle(fs.readFileSync(COLLE, 'utf-8'));
const utilises = symbolesUtilises(SOURCES);
const manquants = [...utilises.keys()].filter(s => !exportes.has(s)).sort();

console.log('ABI du coeur wasm : %d symboles exportes, %d utilises par src/.',
  exportes.size, utilises.size);

if (manquants.length) {
  console.error('\nABI : %d symbole(s) appele(s) par le code mais ABSENT(S) du wasm embarque :',
    manquants.length);
  for (const s of manquants) {
    console.error('  %-40s  <- %s', s, [...utilises.get(s)].join(', '));
  }
  console.error('\nLe coeur vendorise est plus ancien que le code. Rafraichir avec :');
  console.error('  node scripts/fetch-chip-core.js');
  process.exit(1);
}

console.log('ABI : aucun symbole manquant.');
