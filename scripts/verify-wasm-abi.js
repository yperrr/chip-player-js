// Verifie que chaque moteur wasm vendorise expose bien tout ce que src/ lui
// demande.
//
// POURQUOI CE SCRIPT EXISTE
//
// Ce fork ne recompile pas ses moteurs a chaque construction : il embarque des
// couples colle + .wasm produits a part (voir src/*.provenance.json et
// scripts/emscripten/). Le code JavaScript, lui, bouge — soit en suivant
// l'amont, soit sous nos propres mains.
//
// Rien n'empeche donc d'appeler une fonction native que le binaire embarque
// n'exporte pas : symbole ajoute en amont apres le build qu'on a fige, ou
// simplement oublie dans la liste EXPORTED_FUNCTIONS d'une recette emscripten.
//
// Ce desaccord ne se verrait pas a la construction : webpack ne sait rien des
// symboles du wasm. Il se manifesterait a l'execution, sur un format
// particulier, par un « ... is not a function » au moment de lire un fichier —
// c'est-a-dire tard, et chez l'utilisateur.
//
// On le detecte donc ici, avant webpack.
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const SOURCES = path.join(RACINE, 'src');

// Un moteur par couple vendorise. `fichiers` enumere les sources qui
// s'adressent a CE moteur-la ; tout le reste parle au moteur par defaut.
//
// Le routage se fait par fichier et non par prefixe de symbole : _malloc et
// _free sont appeles des deux cotes, un prefixe ne saurait pas les departager.
const MOTEURS = [
  {
    nom: 'libopenmpt',
    colle: 'src/libopenmpt.js',
    fichiers: ['src/players/OpenMPTPlayer.js'],
    correctif: 'reconstruire avec scripts/emscripten/libopenmpt/ en completant EXPORTED_FUNCTIONS',
  },
  {
    nom: 'chip-core',
    colle: 'src/chip-core.js',
    defaut: true,
    correctif: 'rafraichir le couple avec `node scripts/fetch-chip-core.js`',
  },
];

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
function symbolesUtilises(dossier, colles) {
  const utilises = new Map();   // fichier relatif -> Set de symboles
  (function parcourir(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { parcourir(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(RACINE, p).replace(/\\/g, '/');
      if (colles.has(rel)) continue;          // ne pas s'analyser soi-meme
      const texte = fs.readFileSync(p, 'utf-8');
      for (const m of texte.matchAll(/\b(?:this\.)?(?:core|chipCore)\.(_[A-Za-z0-9_]+)/g)) {
        if (!utilises.has(rel)) utilises.set(rel, new Set());
        utilises.get(rel).add(m[1]);
      }
    }
  })(dossier);
  return utilises;
}

const colles = new Set(MOTEURS.map(m => m.colle));
const parDefaut = MOTEURS.find(m => m.defaut);
const utilises = symbolesUtilises(SOURCES, colles);

let enEchec = false;
for (const moteur of MOTEURS) {
  const chemin = path.join(RACINE, moteur.colle);
  // Un moteur dont la colle est absente mais que personne n'appelle n'est pas
  // une erreur : il peut etre en cours d'ajout.
  const siens = [...utilises.keys()].filter(f =>
    moteur.defaut ? !MOTEURS.some(m => m !== moteur && (m.fichiers || []).includes(f))
                  : (moteur.fichiers || []).includes(f));
  const demandes = new Set();
  for (const f of siens) for (const s of utilises.get(f)) demandes.add(s);

  if (!fs.existsSync(chemin)) {
    if (demandes.size === 0) {
      console.log('ABI %s : colle absente, aucun appel — ignore.', moteur.nom.padEnd(12));
      continue;
    }
    console.error('ABI %s : %s est absent alors que %d symbole(s) l\'appellent.',
      moteur.nom, moteur.colle, demandes.size);
    enEchec = true;
    continue;
  }

  const exportes = exportsDeLaColle(fs.readFileSync(chemin, 'utf-8'));
  const manquants = [...demandes].filter(s => !exportes.has(s)).sort();

  console.log('ABI %s : %d symboles exportes, %d utilises par %d fichier(s).',
    moteur.nom.padEnd(12), exportes.size, demandes.size, siens.length);

  if (manquants.length) {
    enEchec = true;
    console.error('\nABI %s : %d symbole(s) appele(s) par le code mais ABSENT(S) du wasm :',
      moteur.nom, manquants.length);
    for (const s of manquants) {
      const ou = siens.filter(f => utilises.get(f).has(s));
      console.error('  %s  <- %s', s.padEnd(44), ou.join(', '));
    }
    console.error('  Correctif : %s\n', moteur.correctif);
  }
}

if (enEchec) process.exit(1);
console.log('ABI : aucun symbole manquant.');
