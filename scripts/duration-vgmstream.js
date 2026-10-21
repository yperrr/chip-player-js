// Duree d'un flux, lue par vgmstream a l'indexation.
//
// A QUOI CELA SERT
//
// A renommer des fichiers dont le nom ne dit rien. Les rips de disque arrivent
// parfois avec des noms opaques — les 212 .brstm de Skyward Sword s'appellent
// « 0A2EB53FB4A43869EF8892CA146BBDF4.brstm », le hachage que le jeu donne a
// ses propres actifs — et le BRSTM ne porte aucune balise de titre. Il n'y a
// donc rien a « detecter » dans le fichier.
//
// Ce qui reste, c'est la DUREE. Les listes de pistes publiees par la
// communaute en donnent une par morceau ; alignees sur celles d'un dossier,
// elles identifient les fichiers sans empreinte acoustique, sans cle d'API et
// sans decoder quoi que ce soit. L'administration s'en sert pour proposer un
// renommage, que l'operateur valide avant ecriture.
//
// POURQUOI LE WASM DU PRODUIT ET PAS vgmstream-cli
//
// Parce que la question n'est pas « vgmstream sait-il lire ce fichier » mais
// « NOTRE build sait-il le lire » : la recette desactive libmpg123, CELT,
// SPEEX et G.719. Une duree annoncee par un binaire amont pourrait designer un
// fichier que le lecteur, lui, refuse. En passant par la meme bibliotheque que
// le navigateur, une duree au catalogue signifie toujours « ce fichier
// s'ouvre ».
//
// CE QUE CELA COUTE
//
// La colle est construite pour le navigateur : elle n'embarque pas NODEFS, et
// vgmstream lit par un chemin. Le fichier doit donc etre copie dans le tas du
// wasm, en entier, avant d'etre ouvert — d'ou le plafond ci-dessous. Seule
// l'EN-TETE est ensuite lue : aucun decodage n'a lieu, la duree etant une
// metadonnee du format.
const fs = require('fs');
const path = require('path');

// Au-dela, on renonce : un vidage de piste CD pese 60 Mo et sa duree
// n'interesse personne — ces fichiers-la ont deja des noms parlants.
const TAILLE_MAX = 96 * 1024 * 1024;

// Decalages de libvgmstream_t / libvgmstream_format_t, identiques a ceux de
// src/players/VGMStreamPlayer.js. Verifies par _plausible() plutot que tenus
// pour acquis : une structure amont qui bougerait rendrait ici des durees
// absurdes au lieu d'une erreur franche.
const LIB_FORMAT_PTR = 4;
const FMT_CHANNELS = 0;
const FMT_SAMPLE_RATE = 4;
const FMT_PLAY_SAMPLES = 64;   // int64

// EXTENSIONS QU'IL NE FAUT PAS MESURER AVEC VGMSTREAM
//
// vgmstream en declare 703, et certaines designent chez lui de TOUT AUTRES
// formats que chez nous. « psf », « ssf », « dsf » et « gsf » sont les plus
// trompeuses : ce sont des programmes de console chez PSFPlayer, des flux
// quelconques chez vgmstream. « spc » et « nsf » appartiennent a GME, « mod »,
// « xm », « it » aux trackers, « mp3 » et « ogg » a l'element audio du
// navigateur.
//
// Ces extensions-la ne sont jamais jouees par VGMStreamPlayer : il figure
// APRES ces moteurs dans l'arbitrage de src/components/App.js, et le
// sequenceur retient le premier qui accepte. Le laisser mesurer leur duree
// rendrait donc une valeur qui ne decrit pas ce que l'utilisateur entend.
//
// Se tromper par exces d'exclusion ne coute qu'une duree absente, ce qui est
// honnete ; se tromper dans l'autre sens inscrit au catalogue une duree
// fausse. On exclut donc largement.
//
// La liste statique vient des fileExtensions de src/players/*.js. Elle doit
// suivre ces fichiers — un moteur qui gagnerait une extension devrait
// l'ajouter ici. Celle de libopenmpt, elle, est lue a l'execution : elle est
// produite par la construction du wasm et derivera sans qu'on y pense.
const RESERVEES_AUX_AUTRES_MOTEURS = [
  // GMEPlayer
  'ay', 'gbs', 'hes', 'kss', 'nsf', 'nsfe', 'sap', 'sgc', 'spc',
  // PSFPlayer — doit suivre ses fileExtensions, que verify-wasm-abi.js
  // confronte a cette liste : elle avait deja derive deux fois.
  'psf', 'minipsf', 'psf2', 'minipsf2', 'ssf', 'minissf', 'dsf', 'minidsf',
  'gsf', 'minigsf',
  // NativeAudioPlayer
  'aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm',
  // VGMPlayer
  'dro', 'gym', 'imf', 's98', 'vgm', 'vgz', 'wlf',
  // XMPPlayer
  'it', 'mod', 's3m', 'xm',
  // MIDIPlayer, SIDPlayer, MDXPlayer, V2MPlayer, N64Player
  'mid', 'midi', 'mus', 'smf', 'sid', 'mdx', 'v2m', 'miniusf',
];

let coeur = null;
let indisponible = null;   // message, si le chargement du wasm a echoue

// Les listes se chargent TOUT DE SUITE, et separement du wasm.
//
// POURQUOI SEPAREMENT. mesurable() repond « ce fichier releve de vgmstream »,
// une propriete de l'extension, pas de l'etat du moteur. Quand les deux
// etaient lies, un wasm indisponible faisait repondre « non » partout — et
// l'indexeur inscrivait alors 0, « deja tente », sur tout le catalogue, qui
// n'aurait plus jamais ete remesure. Dissociees, un echec de chargement laisse
// la colonne vide, donc a reprendre au passage suivant.
const extensions = (() => {
  try {
    const exclues = new Set(RESERVEES_AUX_AUTRES_MOTEURS);
    try {
      for (const e of require('../src/libopenmpt-extensions.json')) exclues.add(e);
    } catch (e) {
      // Liste absente : on garde la statique, un tracker mesure de travers
      // etant moins grave qu'une indexation qui s'arrete.
    }
    return new Set(
      require('../src/vgmstream-extensions.json').filter(e => !exclues.has(e)));
  } catch (e) {
    return new Set();
  }
})();

/** Les extensions que vgmstream declare ET dont il est bien le lecteur. */
function mesurable(ext) {
  return extensions.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

/**
 * Charge le wasm. A appeler UNE FOIS avant le balayage : les transactions de
 * better-sqlite3 sont synchrones, on ne peut donc rien attendre depuis
 * processFile.
 */
async function initialiser({ silencieux = false } = {}) {
  if (coeur || indisponible) return !!coeur;
  const colle = path.join(__dirname, '..', 'src', 'vgmstream.js');
  const binaire = path.join(__dirname, '..', 'src', 'vgmstream.wasm');
  try {
    const mod = await import('file://' + colle.replace(/\\/g, '/'));
    // La colle est construite pour le navigateur (ENVIRONMENT_IS_WEB) et irait
    // chercher le .wasm par fetch ; sous node on le lui remet en main.
    coeur = await mod.default({ wasmBinary: fs.readFileSync(binaire) });
    try { coeur.FS.mkdir('/duree'); } catch (e) { /* existe deja */ }
    return true;
  } catch (e) {
    indisponible = e.message;
    if (!silencieux) {
      console.warn('durees : vgmstream indisponible (%s) — les durees ne '
        + 'seront pas relevees, le reste de l\'indexation est inchange.', e.message);
    }
    return false;
  }
}

function lireI64(ptr) {
  return Number(coeur.HEAPU32[ptr >> 2]) + Number(coeur.HEAPU32[(ptr + 4) >> 2]) * 4294967296;
}

/** Garde-fou : des valeurs hors de ces bornes signalent des decalages faux. */
function plausible(canaux, taux, echantillons) {
  return canaux >= 1 && canaux <= 64
    && taux >= 1000 && taux <= 384000
    && echantillons >= 0 && echantillons <= 0x7fffffff;
}

/**
 * Rend la duree en millisecondes, 0 si vgmstream n'en donne pas, et null si la
 * mesure n'a pas pu etre tentee.
 *
 * La distinction compte pour l'indexeur : 0 veut dire « deja tente, sans
 * resultat » et evite de remesurer le meme fichier a chaque passage, tandis
 * que null laisse la colonne vide et donc a reprendre.
 */
function dureeMs(tampon, nomFichier) {
  if (!coeur) return null;
  if (!tampon || tampon.length === 0 || tampon.length > TAILLE_MAX) return 0;

  const nom = path.basename(nomFichier);
  const chemin = '/duree/' + nom;
  let lib = 0;
  let ptr = 0;
  try {
    coeur.FS.writeFile(chemin, tampon);
    ptr = coeur._malloc(chemin.length + 1);
    coeur.stringToUTF8(chemin, ptr, chemin.length + 1);
    const sf = coeur._libstreamfile_open_from_stdio(ptr);
    if (!sf) return 0;
    lib = coeur._libvgmstream_create(sf, 1, 0);
    coeur._libstreamfile_close(sf);
    if (!lib) return 0;

    const fmt = coeur.HEAPU32[(lib + LIB_FORMAT_PTR) >> 2];
    if (!fmt) return 0;
    const canaux = coeur.HEAP32[(fmt + FMT_CHANNELS) >> 2];
    const taux = coeur.HEAP32[(fmt + FMT_SAMPLE_RATE) >> 2];
    const echantillons = lireI64(fmt + FMT_PLAY_SAMPLES);
    if (!plausible(canaux, taux, echantillons)) return 0;
    return Math.round((echantillons / taux) * 1000);
  } catch (e) {
    return 0;
  } finally {
    if (lib) coeur._libvgmstream_free(lib);
    if (ptr) coeur._free(ptr);
    try { coeur.FS.unlink(chemin); } catch (e) { /* deja parti */ }
  }
}

module.exports = { initialiser, mesurable, dureeMs, TAILLE_MAX };
