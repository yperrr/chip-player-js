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
    nom: 'vgmstream',
    colle: 'src/vgmstream.js',
    fichiers: ['src/players/VGMStreamPlayer.js'],
    correctif: 'reconstruire avec scripts/emscripten/vgmstream/ en completant EXPORTED_FUNCTIONS',
  },
  {
    nom: 'libopenmpt',
    colle: 'src/libopenmpt.js',
    fichiers: ['src/players/OpenMPTPlayer.js'],
    correctif: 'reconstruire avec scripts/emscripten/libopenmpt/ en completant EXPORTED_FUNCTIONS',
  },
  {
    nom: 'libkss',
    colle: 'src/libkss.js',
    fichiers: ['src/players/KSSPlayer.js'],
    correctif: 'reconstruire avec scripts/emscripten/libkss/ en completant EXPORTED_FUNCTIONS',
  },
  {
    nom: 'psf',
    colle: 'src/psf.js',
    fichiers: ['src/players/PSFPlayer.js'],
    correctif: 'reconstruire avec scripts/emscripten/psf/ en completant EXPORTED_FUNCTIONS',
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
//
// Les alias locaux comptent aussi. Un lecteur qui ecrit `const c = this.core`
// avant une boucle serree — VGMStreamPlayer et KSSPlayer le font, et c'est la
// bonne facon d'eviter deux indirections par echantillon — rendait ses appels
// invisibles a ce script, qui annoncait huit symboles la ou le fichier en
// appelle vingt. Un garde-fou qui ne voit pas ce qu'il garde ne garde rien.
function aliasDuCoeur(texte) {
  const noms = new Set(['core', 'chipCore']);
  for (const m of texte.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:this\.)?(?:core|chipCore)\s*[;,\n]/g)) {
    noms.add(m[1]);
  }
  return [...noms];
}

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
      const noms = aliasDuCoeur(texte).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const motif = new RegExp('\\b(?:this\\.)?(?:' + noms.join('|') + ')\\.(_[A-Za-z0-9_]+)', 'g');
      for (const m of texte.matchAll(motif)) {
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

  // L'EN-TETE QUI DESARME LE LINTER.
  //
  // Les colles emscripten sont minifiees et referencent des globales que le
  // linter de Create React App ne connait pas — « Browser is not defined ».
  // Sans cet en-tete, `npm run build-lite` ECHOUE, et pas ici : a la
  // construction de l'image, plusieurs minutes plus tard, sur une erreur qui ne
  // dit rien du moteur concerne.
  //
  // La procedure de vendorisation le rappelle (scripts/emscripten/README.md),
  // mais une procedure s'oublie — celle-ci l'a ete, et a coute un aller-retour
  // de pipeline. Un controle le rend impossible a oublier.
  {
    const debut = fs.readFileSync(chemin, 'latin1').slice(0, 64);
    if (!debut.startsWith('/*eslint-disable*/')) {
      console.error('ABI %s : %s ne commence pas par /*eslint-disable*/. '
        + 'La colle vendorisee doit le porter, sinon la construction du lecteur '
        + 'echoue au linter. Voir scripts/emscripten/README.md.',
        moteur.nom, moteur.colle);
      enEchec = true;
      continue;
    }
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
// --- Les extensions de PSFPlayer sont-elles exclues de la mesure de duree ? --
//
// scripts/duration-vgmstream.js tient la liste des extensions que vgmstream ne
// doit PAS mesurer, parce qu'un autre moteur les joue. Celle de PSFPlayer y a
// derive deux fois : « psf2 » oublie a l'ajout de la PlayStation 2, « gsf » a
// celui de la Game Boy Advance. Or « gsf » designe chez vgmstream un tout
// autre format — la duree inscrite au catalogue aurait ete celle d'un fichier
// que personne n'ecoute, et rien ne l'aurait signale.
//
// On confronte donc les deux listes ici, dans le controle qui tourne deja en
// porte du Dockerfile.
{
  const litteral = (chemin, motif) => {
    try {
      const m = motif.exec(fs.readFileSync(path.join(RACINE, chemin), 'utf-8'));
      return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1]) : null;
    } catch (e) {
      return null;
    }
  };
  const duPsf = litteral('src/players/PSFPlayer.js',
    /const fileExtensions = \[([\s\S]*?)\]/);
  const exclues = litteral('scripts/duration-vgmstream.js',
    /const RESERVEES_AUX_AUTRES_MOTEURS = \[([\s\S]*?)\n\]/);

  if (!duPsf || !exclues) {
    console.warn('Durees : listes illisibles, controle ignore.');
  } else {
    const oubliees = duPsf.filter(e => !exclues.includes(e));
    if (oubliees.length) {
      console.error('Durees : %s manque(nt) dans RESERVEES_AUX_AUTRES_MOTEURS de '
        + 'scripts/duration-vgmstream.js. vgmstream mesurerait ces fichiers avec '
        + 'un autre format que celui qui les joue.', oubliees.join(', '));
      enEchec = true;
    } else {
      console.log('Durees : les %d extensions de PSFPlayer sont bien exclues.', duPsf.length);
    }
  }
}

if (enEchec) process.exit(1);
console.log('ABI : aucun symbole manquant.');
