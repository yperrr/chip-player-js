import Player from './Player.js';
import autoBind from 'auto-bind';
import EXTENSIONS_VGMSTREAM from '../vgmstream-extensions.json';
import EXTENSIONS_HORS_LISTE from '../vgmstream-extensions-hors-liste';
import { API_BASE, CATALOG_PREFIX } from '../config';
import { pathJoin } from '../util';

// La liste vient de la bibliotheque elle-meme : elle est relevee a la
// construction du wasm par scripts/emscripten/vgmstream/, en appelant
// libvgmstream_get_extensions() sur le binaire embarque. Plus de 700 entrees,
// qu'il serait deraisonnable de tenir a jour a la main.
//
// Aucune mise a l'ecart n'est necessaire ici, contrairement a OpenMPTPlayer :
// ce lecteur est place EN DERNIER dans src/components/App.js, et le sequenceur
// retient le premier moteur qui accepte l'extension. Les onze extensions que
// vgmstream partage avec un moteur plus specialise — spc, vgm, mus, imf, med,
// ams, dbm, stm, stx, sfx, oga — reviennent donc naturellement a celui-ci.
// C'est le role d'un moteur generaliste : prendre ce que personne ne reclame.
//
// vgmstream-extensions.json est produit par la recette de construction, a
// partir de la bibliotheque elle-meme, et figure dans la provenance : on ne le
// retouche pas a la main, sans quoi il mentirait des la prochaine
// reconstruction. Ce qui s'ajoute a cette liste se declare donc a cote, et
// pour deux raisons distinctes.
//
// 1. Les extensions que vgmstream NE DECLARE PAS et que seuls NOS replis
//    couvrent : _tenterCdDaNu et son .txth. « pcm » et « xa », eux, sont deja
//    dans la liste de la bibliotheque.
const EXTENSIONS_REPLI = ['swp'];

// 2. Les extensions que la bibliotheque sait lire sans les revendiquer.
//    vgmstream-extensions-hors-liste.js, partage avec
//    scripts/duration-vgmstream.js pour que les deux ne derivent pas.
const fileExtensions = [
  ...EXTENSIONS_VGMSTREAM, ...EXTENSIONS_REPLI, ...EXTENSIONS_HORS_LISTE];

// Un secteur de disque compact : 2352 octets, soit 588 trames de 16 bits
// stereo — exactement 1/75 de seconde a 44 100 Hz. Un vidage de piste CD en
// est toujours un multiple exact ; c'est ce qui identifie les .swp de WipEout.
const SECTEUR_CD = 2352;

// Seuil de continuite. Mesure : 0,989 et 0,973 pour la bonne interpretation,
// 0,004 et moins pour toutes les autres. A 0,5 on reste large sans jamais
// accepter du bruit.
const CONTINUITE_MIN = 0.5;

const SFMT_PCM16 = 1;
const SFMT_FLOAT = 4;

// FICHIERS VOISINS
//
// Un .txtp ne contient pas de son : c'est une recette de vgmstream qui renvoie
// a d'autres fichiers du dossier (« MVB/ALPINE.MVB#2 », « wem/123.wem #i »),
// avec des sous-pistes, des couches, des boucles. Un .txth decrit de meme le
// flux brut qui porte son nom. Le catalogue en compte pres d'un millier
// (Xenoblade, Terraria, Sonic Mania, Gitaroo Man...), restes muets tant que
// seul le fichier joue arrivait au moteur.
//
// vgmstream ouvre ces voisins par chemin, de facon synchrone : on les tire
// donc du catalogue AVANT d'ouvrir, et on les depose sous RACINE_VOISINS en
// reproduisant l'arborescence du catalogue, pour que les chemins relatifs
// tombent juste. Ils restent en place tant que les morceaux suivants s'en
// servent : les trois versions d'un circuit de Porsche Challenge partagent un
// .MVB de 95 Mo, qu'il serait absurde de retelecharger a chaque morceau.
const RACINE_VOISINS = '/voisins';
const PROFONDEUR_TXTP_MAX = 4;

// DESCRIPTIONS DE FORMATS « RESERVES AU TXTH »
//
// vgmstream reserve certaines extensions a des flux sans en-tete qu'il ne lit
// qu'accompagnes d'un .txth. Quand le rip ne l'a pas fourni, on le fournit.
//
// mvb — Porsche Challenge (PS1). Releve sur les quatre circuits :
//   - De l'ADPCM PlayStation sans en-tete, en blocs de 0x800 octets qui
//     bouclent chacun sur eux-memes (drapeaux 6 puis 3) : la technique de
//     flux du SPU, un bloc par secteur de CD.
//   - Dix voies entrelacees bloc a bloc, soit cinq paires stereo. Les paires
//     inutilisees sont des COPIES de la voie 0 : USA en remplit quatre,
//     ALPINE et JAP trois, STUT deux, et la cinquieme ne l'est jamais. D'ou
//     quatre sous-pistes, la base (#1) et ses variantes, que les .txtp du
//     rip superposent deux a deux.
//   - 22 695 Hz : sur les voies tonales, les pics du spectre tombent a 4
//     cents de la gamme temperee a cette cadence, contre 46 a 22 050 Hz.
//     C'est aussi la cadence du .txth livre pour MENU_SND.VB, du meme jeu.
//   La disposition est celle de l'exemple « Street Fighter EX3 » de la
//   documentation TXTH : les morceaux de 0x1000 octets se « dechunkent » par
//   sous-piste avant d'etre lus.
const TXTH_INTEGRES = {
  mvb: [
    'codec = PSX',
    'sample_rate = 22695',
    'channels = 2',
    'interleave = 0x800',
    'subsong_count = 4',
    'chunk_start = 0',
    'chunk_size = 0x1000',
    'chunk_count = 5',
    'start_offset = 0',
    'num_samples = data_size',
    '',
  ].join('\n'),
};

function extensionDe(nom) {
  const m = /\.([^./]+)$/.exec(nom || '');
  return m ? m[1].toLowerCase() : '';
}

// Chemin du catalogue -> URL, segment par segment : un « # » ou un « ? »
// dans un nom de fichier ne doit pas devenir une ancre ou une requete.
function urlDuCatalogue(chemin) {
  return pathJoin(CATALOG_PREFIX, chemin.split('/').filter(Boolean).map(encodeURIComponent).join('/'));
}

// Resout « a/./b/../c » ; rend null si le chemin sort du catalogue.
function normaliser(chemin) {
  const pile = [];
  for (const seg of chemin.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!pile.length) return null;
      pile.pop();
    } else {
      pile.push(seg);
    }
  }
  return pile.join('/');
}

/**
 * Les fichiers qu'un .txtp nomme, tels qu'ecrits (separateurs normalises).
 *
 * Une ligne est soit vide, soit un commentaire (« # ... »), soit un reglage
 * (« mode = layers »), soit un fichier suivi de ses commandes : « x.wem#2 »,
 * « x.wem #i #b 12.0 ». Le nom s'arrete donc au premier « # ».
 */
function fichiersDuTxtp(texte) {
  const noms = [];
  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.trim();
    if (!ligne || ligne.startsWith('#')) continue;
    if (/^[a-z_]+\s*=/i.test(ligne)) continue;
    const nom = ligne.split('#')[0].trim().replace(/\\/g, '/');
    if (nom && !noms.includes(nom)) noms.push(nom);
  }
  return noms;
}

// Decalages des structures de src/libvgmstream.h, pour wasm32 : pointeurs sur
// 4 octets, int64 et double alignes sur 8.
//
// Ils sont verifies a l'ouverture (voir _verifierDecalages) plutot que tenus
// pour acquis : une structure amont qui bougerait donnerait ici des valeurs
// absurdes — un taux d'echantillonnage de trois milliards — au lieu d'une
// erreur franche.
const LIB_FORMAT_PTR = 4;          // libvgmstream_t.format
const LIB_DECODER_PTR = 8;         // libvgmstream_t.decoder
const DEC_BUF = 0;                 // libvgmstream_decoder_t.buf
const DEC_BUF_SAMPLES = 4;         // libvgmstream_decoder_t.buf_samples
const DEC_DONE = 12;               // libvgmstream_decoder_t.done
const FMT_SAMPLE_FORMAT = 8;       // libvgmstream_format_t.sample_format

const FMT_CHANNELS = 0;
const FMT_SAMPLE_RATE = 4;
const FMT_SUBSONG_COUNT = 24;
const FMT_PLAY_SAMPLES = 64;       // int64
const FMT_CODEC_NAME = 76;         // char[128]
const FMT_META_NAME = 332;         // char[128]
const FMT_STREAM_NAME = 460;       // char[256]

export default class VGMStreamPlayer extends Player {
  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : charge au premier fichier, comme
    // OpenMPTPlayer. Le wasm pese ~1,2 Mo et la plupart des pages ne liront
    // jamais de flux console.
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'vgmstream';
    this.name = 'vgmstream Player';
    this.fileExtensions = fileExtensions;
    this.lib = 0;            // libvgmstream_t*
    this._reste = 0;         // echantillons restants dans le bloc decode
    this._prec = null;       // derniere trame du bloc precedent, indice -1
    this._termine = false;  // fin deja signalee ?
    this._surPlace = 0;      // tampons consecutifs sans progression
    this._pos = 0;           // position fractionnaire dans ce bloc
    this._bufPtr = 0;
    this.cheminFs = null;
    this.cheminTxth = null;
    this._subtune = 0;
    this._nbSubtunes = 1;
    this._dureeMs = 0;
    this.infoTexts = [];
    this._voisins = new Set();  // chemins deposes sous RACINE_VOISINS
    this._jeton = 0;            // numero du dernier chargement demande
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../vgmstream');
    this.core = await mod.default();
    // Pas de tampon a reserver : render() rend le sien, decrit par
    // lib->decoder, et processAudioInner y lit directement.
  }

  _chaine(ptr, max) {
    return ptr ? this.core.UTF8ToString(ptr, max) : '';
  }

  get _format() {
    return this.lib ? this.core.getValue(this.lib + LIB_FORMAT_PTR, '*') : 0;
  }

  /**
   * Controle de vraisemblance des decalages de structure.
   *
   * Les offsets sont calcules a la main depuis l'en-tete amont. Si celui-ci
   * change, les lectures deviennent silencieusement fausses. On refuse donc le
   * fichier plutot que de jouer du bruit a un taux d'echantillonnage invente.
   */
  _decalagesPlausibles(fmt) {
    const canaux = this.core.getValue(fmt + FMT_CHANNELS, 'i32');
    const taux = this.core.getValue(fmt + FMT_SAMPLE_RATE, 'i32');
    return canaux >= 1 && canaux <= 32 && taux >= 1000 && taux <= 384000;
  }

  _nettoyer() {
    if (this.lib) {
      this.core._libvgmstream_free(this.lib);
      this.lib = 0;
    }
    if (this.cheminTxth) {
      try { this.core.FS.unlink(this.cheminTxth); } catch (e) { /* deja parti */ }
      this.cheminTxth = null;
    }
    if (this.cheminFs) {
      try { this.core.FS.unlink(this.cheminFs); } catch (e) { /* deja parti */ }
      this.cheminFs = null;
    }
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    // Conserves pour playSubtune : les sous-pistes de vgmstream sont des flux
    // distincts, il faut rouvrir le fichier, et le sequenceur ne redonne pas
    // les octets.
    this._donnees = data;
    this._nomFichier = filename;
    this._nettoyer();
    // Le telechargement des voisins peut durer : si un autre morceau est
    // demande entre-temps, celui-ci renonce sans rien signaler.
    const jeton = ++this._jeton;

    // vgmstream lit par un « streamfile » et reconnait beaucoup de formats a
    // l'extension : on ecrit donc le fichier dans le systeme de fichiers
    // d'emscripten sous son vrai nom, et on le lui ouvre par chemin. Cela evite
    // d'exposer des pointeurs de fonction au JavaScript pour l'interface d'E/S.
    const nom = filename.split('/').pop();
    const ext = extensionDe(nom);
    if (ext === 'txtp' || ext === 'txth') {
      const chemin = await this._deposerVoisins(data, filename, ext, jeton);
      if (jeton !== this._jeton) return;
      this.lib = this._ouvrir(chemin);
      if (!this.lib) {
        this._nettoyer();
        throw Error(ext === 'txtp' ? 'vgmstream: recette .txtp non lue' : 'vgmstream: description .txth non lue');
      }
    } else {
      this._garderVoisins(new Set());
      this.cheminFs = '/tmp/' + nom;
      try { this.core.FS.mkdir('/tmp'); } catch (e) { /* existe deja */ }
      this.core.FS.writeFile(this.cheminFs, data);
      this.lib = this._ouvrir(this.cheminFs)
        || this._tenterTxthIntegre(ext)
        || this._tenterAtrac3Nu(nom)
        || this._tenterCdDaNu(nom, data);
    }

    if (!this.lib) {
      this._nettoyer();
      throw Error('vgmstream: format non reconnu');
    }

    const fmt = this._format;
    if (!fmt || !this._decalagesPlausibles(fmt)) {
      this._nettoyer();
      throw Error('vgmstream: structure inattendue (en-tete amont modifie ?)');
    }

    this._lireMetadonnees(fmt);
    // Le flux d'un .txtp porte le nom du fichier qu'il lit : les trois
    // versions d'un circuit s'intituleraient toutes « ALPINE ». Le nom de la
    // recette est le seul qui les distingue.
    if (ext === 'txtp') this.metadata.title = this.filepathMeta.title;
    this.resolveParamValues(persistedSettings);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  /**
   * Ouvre un fichier deja depose, ou rend 0.
   *
   * Aucune configuration passee : les valeurs par defaut conviennent (une
   * boucle, fondu standard), et surtout cela evite de dependre des decalages
   * de libvgmstream_config_t, que rien ne verifierait. On lit le format de
   * sortie plutot que de l'imposer.
   */
  _ouvrir(chemin) {
    const c = this.core;
    // En octets UTF-8, pas en caracteres : un nom accentue serait tronque.
    const n = c.lengthBytesUTF8(chemin) + 1;
    const ptr = c._malloc(n);
    c.stringToUTF8(chemin, ptr, n);
    const sf = c._libstreamfile_open_from_stdio(ptr);
    c._free(ptr);
    if (!sf) return 0;
    const lib = c._libvgmstream_create(sf, this._subtune + 1, 0);
    c._libstreamfile_close(sf);
    return lib;
  }

  /** Un format reserve au txth, livre sans le sien : voir TXTH_INTEGRES. */
  _tenterTxthIntegre(ext) {
    const txth = TXTH_INTEGRES[ext];
    if (!txth) return 0;
    this.cheminTxth = this.cheminFs + '.txth';
    try {
      this.core.FS.writeFile(this.cheminTxth, new TextEncoder().encode(txth));
    } catch (e) {
      this.cheminTxth = null;
      return 0;
    }
    return this._ouvrir(this.cheminFs);
  }

  /**
   * Depose un .txtp ou un .txth et les fichiers auxquels il renvoie, et rend
   * le chemin a ouvrir. Voir RACINE_VOISINS.
   *
   *   .txtp  On l'ouvre lui-meme ; ses fichiers, et les .txtp qu'il inclut,
   *          sont tires du catalogue.
   *   .txth  « X.VB.TXTH » decrit « X.VB » : on ouvre le corps, et vgmstream
   *          trouve sa description en ajoutant « .txth » a son nom — en
   *          minuscules, le systeme de fichiers d'emscripten distinguant la
   *          casse. Un « TXTH inverse » (body_file) s'ouvre, lui, tel quel.
   */
  async _deposerVoisins(data, filename, ext, jeton) {
    if (/^local\//.test(filename)) {
      throw Error('vgmstream: un fichier local ne donne pas acces a ses voisins');
    }
    const chemin = normaliser(filename);
    const dossierDe = p => p.split('/').slice(0, -1).join('/');
    const resoudre = (base, nom) => {
      const cible = normaliser(dossierDe(base) + '/' + nom.replace(/\\/g, '/'));
      if (!cible) throw Error(`vgmstream: « ${nom} » sort du catalogue`);
      return cible;
    };
    // chemin du catalogue -> octets, ou null tant qu'ils restent a tirer
    const requis = new Map([[chemin, data]]);
    let aOuvrir = chemin;

    if (ext === 'txtp') {
      const aLire = [[chemin, data, 0]];
      while (aLire.length) {
        const [p, octets, profondeur] = aLire.shift();
        for (const nom of fichiersDuTxtp(new TextDecoder().decode(octets))) {
          const cible = resoudre(p, nom);
          if (requis.has(cible)) continue;
          requis.set(cible, null);
          if (extensionDe(cible) === 'txtp') {
            if (profondeur >= PROFONDEUR_TXTP_MAX) throw Error('vgmstream: .txtp imbriques trop profondement');
            const inclus = await this._telecharger(cible);
            if (jeton !== this._jeton) return null;
            requis.set(cible, inclus);
            aLire.push([cible, inclus, profondeur + 1]);
          }
        }
      }
    } else {
      const corps = /^[ \t]*body_file[ \t]*=[ \t]*([^#\r\n]+)/m.exec(new TextDecoder().decode(data));
      if (corps && !corps[1].trim().startsWith('*')) {
        requis.set(resoudre(chemin, corps[1].trim()), null);
      } else {
        aOuvrir = chemin.replace(/\.txth$/i, '');
        requis.delete(chemin);
        requis.set(aOuvrir, null);
        requis.set(aOuvrir + '.txth', data);
      }
    }

    // Les formats reserves au txth recoivent le leur, faute de mieux.
    for (const p of [...requis.keys()]) {
      const txth = TXTH_INTEGRES[extensionDe(p)];
      if (txth && !requis.has(p + '.txth')) requis.set(p + '.txth', new TextEncoder().encode(txth));
    }

    // On libere d'abord ce qui ne sert plus : deux .MVB de 95 Mo en memoire
    // a la fois, ce serait un de trop.
    const versFs = p => RACINE_VOISINS + '/' + p;
    this._garderVoisins(new Set([...requis.keys()].map(versFs)));

    const c = this.core;
    for (const [p, octets] of requis) {
      const fs = versFs(p);
      // Deja la depuis le morceau precedent : un voisin ne change pas d'un
      // morceau a l'autre. Les octets connus, eux, sont toujours reecrits.
      if (!octets && this._voisins.has(fs) && c.FS.analyzePath(fs).exists) continue;
      const contenu = octets || await this._telecharger(p);
      if (jeton !== this._jeton) return null;
      c.FS.mkdirTree(dossierDe(fs));
      c.FS.writeFile(fs, contenu);
      this._voisins.add(fs);
    }
    return versFs(aOuvrir);
  }

  async _telecharger(chemin) {
    let r = await fetch(urlDuCatalogue(chemin));
    if (r.status === 404) {
      const reel = await this._casseReelle(chemin);
      if (reel) r = await fetch(urlDuCatalogue(reel));
    }
    if (!r.ok) throw Error(`vgmstream: fichier voisin « ${chemin.split('/').pop()} » introuvable (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /**
   * Le vrai nom d'un fichier mal capitalise, ou null.
   *
   * Les recettes s'ecrivent sous Windows, qui ignore la casse ; le serveur,
   * lui, la respecte. Releve sur Sonic Generations : dix-huit .txtp nomment
   * « PAM\BB069_PAM17I_wav.aax », le fichier s'appelle « ...PAM17i... ». On
   * cherche donc le nom dans la liste du dossier, sans tenir compte de la
   * casse. Le dossier lui-meme doit etre juste.
   */
  async _casseReelle(chemin) {
    const segments = chemin.split('/');
    const dossier = segments.slice(0, -1).map(encodeURIComponent).join('/');
    try {
      const r = await fetch(`${API_BASE}/browse?path=/${dossier}`);
      if (!r.ok) return null;
      const cherche = chemin.toLowerCase();
      const trouve = (await r.json()).find(e => e.type === 'file' && String(e.path).toLowerCase() === cherche);
      return trouve ? trouve.path : null;
    } catch (e) {
      return null;
    }
  }

  /** Efface les voisins deposes qui ne figurent pas dans « garder ». */
  _garderVoisins(garder) {
    for (const fs of this._voisins) {
      if (garder.has(fs)) continue;
      try { this.core.FS.unlink(fs); } catch (e) { /* deja parti */ }
      this._voisins.delete(fs);
    }
  }

  /**
   * Dernier recours pour un ATRAC3 sans conteneur.
   *
   * Certains rips de PlayStation 2 livrent le flux ATRAC3 NU, sans en-tete
   * RIFF : vgmstream n'a alors rien a reconnaitre et refuse le fichier. Releve
   * sur « Playstation 2/Kingdom Hearts II » : les trois pistes d'Utada Hikaru
   * commencent par a2 00 03 ae, partagent leurs seize premiers octets d'un
   * morceau a l'autre, et n'ont aucun fichier descripteur a cote. Les .at3 de
   * PSP, eux, sont de vrais RIFF/WAVE et passent sans rien faire : sur
   * vingt-cinq tires au hasard du catalogue, vingt-cinq etaient en RIFF.
   *
   * vgmstream sait lire un flux nu si on lui DECRIT le format, par un fichier
   * .txth depose a cote. On en ecrit donc un : stereo joint, trames de
   * 384 octets, 48 000 Hz.
   *
   * LA CADENCE A ETE MESUREE, PAS SUPPOSEE. Rien dans un flux ATRAC3 ne la
   * porte : c'est une metadonnee du conteneur, et il n'y en a pas. On avait
   * d'abord retenu 44 100 Hz, la valeur canonique de Sony pour des trames de
   * 384 octets — a tort. L'utilisateur a trouve que ça trainait, et la
   * comparaison avec l'enregistrement d'origine lui a donne raison : en
   * recalant les enveloppes d'energie des deux versions par correlation
   * croisee, le facteur d'echelle optimal ressort a 1,0884, soit exactement
   * 48 000 / 44 100. Le score passe de 0,35 a 0,63 entre les deux hypotheses,
   * et le balayage fin pointe 47 981 Hz. Les 292 s de l'original
   * correspondent alors a nos 294 s, la ou 44 100 Hz en donnait 320.
   *
   * 48 kHz est d'ailleurs la cadence du processeur audio de la PlayStation 2,
   * ce qui rend la valeur d'autant plus vraisemblable pour un rip de cette
   * console.
   *
   * ON VERIFIE ENSUITE QUE CA DECODE VRAIMENT. Ouvrir ne prouve rien : avec de
   * mauvais parametres, ATRAC3 ouvre tout de meme et rend n'importe quoi.
   * Mesure a l'appui — en 192 octets par trame, le meme fichier sort une crete
   * de 11,97, douze fois la pleine echelle, c'est-a-dire du charabia ; en 304,
   * du silence ; en 384, une crete de 0,46 et une correlation de 0,997 entre
   * echantillons voisins, signature d'un son tonal. On rejette donc tout
   * decodage dont l'amplitude sort des clous.
   */
  _tenterAtrac3Nu(nom) {
    if (!/\.(at3|aa3|oma)$/i.test(nom)) return 0;
    const c = this.core;
    const txth = [
      'codec = ATRAC3',
      'channels = 2',
      'sample_rate = 48000',
      'interleave = 384',
      'num_samples = data_size',
      '',
    ].join('\n');
    this.cheminTxth = this.cheminFs + '.txth';
    try {
      c.FS.writeFile(this.cheminTxth, new TextEncoder().encode(txth));
    } catch (e) {
      this.cheminTxth = null;
      return 0;
    }

    const ptr = c._malloc(this.cheminFs.length + 1);
    c.stringToUTF8(this.cheminFs, ptr, this.cheminFs.length + 1);
    const sf = c._libstreamfile_open_from_stdio(ptr);
    c._free(ptr);
    if (!sf) return 0;
    const lib = c._libvgmstream_create(sf, this._subtune + 1, 0);
    c._libstreamfile_close(sf);
    if (!lib) return 0;

    if (!this._decodageSain(lib)) {
      c._libvgmstream_free(lib);
      return 0;
    }
    c._libvgmstream_seek(lib, BigInt(0));
    return lib;
  }

  /**
   * Repli pour un vidage de piste CD brut : les .swp de WipEout et les
   * .swp.pcm de WipEout XL.
   *
   * CE QUE SONT CES FICHIERS. Rien ne les annonce : leurs trente-deux premiers
   * octets sont nuls et vgmstream les refuse. Ce sont des echantillons sans
   * en-tete, 16 bits signes petit-boutiste, stereo, 44 100 Hz. Trois mesures
   * independantes le disent, et aucune n'est une supposition :
   *
   *   - La TAILLE. 55 558 944 et 64 440 096 octets sont des multiples exacts
   *     de 2352 — la taille d'un secteur de disque compact. Or 2352 octets
   *     font 588 trames de 16 bits stereo, soit precisement 1/75 de seconde a
   *     44 100 Hz : la cadence des secteurs d'un CD audio. Cette unite n'a de
   *     sens a aucune autre combinaison de largeur, de canaux ou de cadence.
   *   - La CONTINUITE. L'autocorrelation au decalage 1 vaut 0,989 et 0,973 en
   *     lisant du 16 bits petit-boutiste, contre 0,004 et 0,000 en gros-
   *     boutiste, et ~0 en 8 bits. Une forme d'onde echantillonnee est
   *     continue d'un echantillon au suivant ; une mauvaise interpretation
   *     retombe sur du bruit. Une seule lecture tient debout.
   *   - Le SPECTRE. L'energie monte sans rupture jusqu'a Nyquist, avec une
   *     simple pente de -39 puis -49 dB dans les deux dernieres vingtiemes.
   *     Un flux de 37 800 Hz (CD-XA) lu a 44 100 montrerait une falaise a
   *     0,857 de Nyquist, une source MP3 une coupure vers 0,72. Ni l'une ni
   *     l'autre.
   *
   * POURQUOI LA REGLE EST AUSSI ETROITE. On avait d'abord voulu deduire le
   * nombre de canaux du signal, en comparant l'autocorrelation aux decalages
   * 1 et 2 : un flux stereo entrelace est plus correle au decalage 2, qui
   * retombe sur le meme canal. Mesure, ce critere se trompe — sur
   * DUSTUP.SWP.PCM il rend 0,9719 contre 0,9669 et conclut « mono », parce
   * que les deux canaux y sont quasi identiques (correlation 0,984). Se fier
   * a lui aurait joue le morceau une octave trop bas.
   *
   * On s'en tient donc a la preuve qu'on a : l'alignement sur le secteur. Une
   * taille qui n'est pas un multiple de 2352 ne decrit pas un vidage de piste
   * CD, et on preferera le dire — « format non reconnu » — plutot que
   * d'inventer une disposition.
   */
  _tenterCdDaNu(nom, data) {
    if (!/\.(swp|pcm)$/i.test(nom)) return 0;
    if (!data || data.length === 0 || data.length % SECTEUR_CD !== 0) return 0;
    if (this._continuitePcm16Stereo(data) < CONTINUITE_MIN) return 0;

    const c = this.core;
    const txth = [
      'codec = PCM16LE',
      'channels = 2',
      'sample_rate = 44100',
      'num_samples = data_size',
      '',
    ].join('\n');
    this.cheminTxth = this.cheminFs + '.txth';
    try {
      c.FS.writeFile(this.cheminTxth, new TextEncoder().encode(txth));
    } catch (e) {
      this.cheminTxth = null;
      return 0;
    }

    const ptr = c._malloc(this.cheminFs.length + 1);
    c.stringToUTF8(this.cheminFs, ptr, this.cheminFs.length + 1);
    const sf = c._libstreamfile_open_from_stdio(ptr);
    c._free(ptr);
    if (!sf) return 0;
    const lib = c._libvgmstream_create(sf, this._subtune + 1, 0);
    c._libstreamfile_close(sf);
    if (!lib) return 0;

    if (!this._decodageSain(lib)) {
      c._libvgmstream_free(lib);
      return 0;
    }
    c._libvgmstream_seek(lib, BigInt(0));
    return lib;
  }

  /**
   * Autocorrelation au decalage 1 du canal gauche, lu en 16 bits signes
   * petit-boutiste entrelace sur deux canaux.
   *
   * On echantillonne au MILIEU du fichier : ces vidages commencent par du
   * silence, et du silence est parfaitement « continu » — il validerait
   * n'importe quelle interpretation.
   */
  _continuitePcm16Stereo(data) {
    const PAR_TRAME = 4;                 // 2 canaux x 16 bits
    let debut = data.length >> 1;
    debut -= debut % PAR_TRAME;
    const n = Math.min(8192, Math.floor((data.length - debut) / PAR_TRAME));
    if (n < 1024) return 0;
    const vue = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let somme = 0;
    for (let i = 0; i < n; i++) somme += vue.getInt16(debut + i * PAR_TRAME, true);
    const moy = somme / n;
    let num = 0, den = 0;
    let prec = vue.getInt16(debut, true) - moy;
    den += prec * prec;
    for (let i = 1; i < n; i++) {
      const v = vue.getInt16(debut + i * PAR_TRAME, true) - moy;
      num += prec * v;
      den += v * v;
      prec = v;
    }
    return den > 0 ? num / den : 0;
  }

  /** Les premiers blocs tiennent-ils dans l'echelle ? */
  _decodageSain(lib) {
    const c = this.core;
    const fmt = c.getValue(lib + LIB_FORMAT_PTR, '*');
    if (!fmt) return false;
    const nCanaux = c.getValue(fmt + FMT_CHANNELS, 'i32') || 1;
    const estFloat = c.getValue(fmt + FMT_SAMPLE_FORMAT, 'i32') === SFMT_FLOAT;
    let crete = 0;
    for (let i = 0; i < 24; i++) {
      if (c._libvgmstream_render(lib) < 0) break;
      const dec = c.getValue(lib + LIB_DECODER_PTR, '*');
      const buf = c.getValue(dec + DEC_BUF, '*');
      const n = c.getValue(dec + DEC_BUF_SAMPLES, 'i32');
      if (n <= 0) break;
      for (let k = 0; k < n; k++) {
        const v = estFloat ? c.HEAPF32[(buf >> 2) + k * nCanaux]
                           : c.HEAP16[(buf >> 1) + k * nCanaux] / 32768;
        const a = Math.abs(v);
        if (a > crete) crete = a;
      }
    }
    // Deux fois la pleine echelle laisse de la marge a un decodeur flottant,
    // tout en ecartant sans ambiguite le cas mesure a 11,97.
    return crete <= 2;
  }

  _lireMetadonnees(fmt) {
    const c = this.core;
    const tauxFichier = c.getValue(fmt + FMT_SAMPLE_RATE, 'i32');
    const echantillons = Number(c.getValue(fmt + FMT_PLAY_SAMPLES, 'i64'));
    this._dureeMs = tauxFichier > 0 ? (echantillons / tauxFichier) * 1000 : 0;
    this._nbSubtunes = Math.max(1, c.getValue(fmt + FMT_SUBSONG_COUNT, 'i32'));
    this._canaux = c.getValue(fmt + FMT_CHANNELS, 'i32');
    this._tauxFichier = tauxFichier;
    const sfmt = c.getValue(fmt + FMT_SAMPLE_FORMAT, 'i32');
    this._estFloat = sfmt === SFMT_FLOAT;
    if (sfmt !== SFMT_FLOAT && sfmt !== SFMT_PCM16) {
      // 24 et 32 bits existent mais sont rares. Mieux vaut le dire que jouer
      // du bruit en interpretant les octets de travers.
      throw Error('vgmstream: format de sortie non gere (' + sfmt + ')');
    }
    this._reste = 0; this._pos = 0; this._bufPtr = 0; this._prec = null;
    this._termine = false;
    this._surPlace = 0;

    const codec = this._chaine(fmt + FMT_CODEC_NAME, 128);
    const meta = this._chaine(fmt + FMT_META_NAME, 128);
    const nomFlux = this._chaine(fmt + FMT_STREAM_NAME, 256);

    this.metadata = {
      title: nomFlux || this.filepathMeta.title,
      system: meta || this.filepathMeta.system,
      codec,
      numChannels: this._canaux,
      sampleRate: tauxFichier,
    };
    const textes = [];
    if (codec) textes.push('Codec: ' + codec);
    if (meta) textes.push('Format: ' + meta);
    this.infoTexts = textes.length ? [textes.join('\n')] : [];
  }

  /**
   * Rendu par libvgmstream_render(), et non par libvgmstream_fill().
   *
   * fill() est pourtant fait pour remplir un tampon fourni, ce qui irait bien
   * ici — mais dans cette construction il rend 0 echantillon sans signaler
   * d'erreur, quel que soit le nombre d'appels. render(), l'API principale,
   * livre les siens correctement : vgmstream fournit alors son propre tampon,
   * decrit par lib->decoder.
   *
   * REECHANTILLONNAGE
   *
   * Les autres moteurs du lecteur recoivent le taux du contexte audio a la
   * construction et decodent directement a ce taux. vgmstream, lui, decode au
   * taux du FICHIER et n'offre aucun reechantillonneur. Recopier ses
   * echantillons tels quels revient donc a les jouer a 48000 / taux du
   * fichier : mesure sur le catalogue DS, 1,47x a 32 728 Hz et 2,17x a
   * 22 767 Hz, et bien davantage sur les taux bas. C'est le « dix fois trop
   * vite » rapporte.
   *
   * On interpole donc lineairement entre deux echantillons source. La
   * frontiere entre deux blocs decodes demande un soin particulier : tenir le
   * dernier echantillon du bloc, faute de connaitre le premier du suivant,
   * aplatit une position sur mille et fait entendre un bourdonnement a la
   * cadence des blocs. On garde donc cette derniere trame dans _prec, et
   * l'intervalle a cheval s'interpole entre elle et le premier echantillon du
   * bloc suivant — _pos vaut alors entre -1 et 0, et l'indice -1 designe _prec.
   */
  processAudioInner(channels) {
    if (this.paused || !this.lib) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const c = this.core;
    const nCanaux = this._canaux || 1;
    const attendus = channels[0].length;
    // Combien d'echantillons source consommes par echantillon de sortie.
    const pas = (this._tauxFichier || this.sampleRate) / this.sampleRate;
    let ecrits = 0;
    let fini = false;

    const lire = (indice, canal) => {
      const idx = indice * nCanaux + Math.min(canal, nCanaux - 1);
      return this._estFloat
        ? c.HEAPF32[(this._bufPtr >> 2) + idx]
        : c.HEAP16[(this._bufPtr >> 1) + idx] / 32768;
    };

    while (ecrits < attendus) {
      // On change de bloc UN echantillon avant la fin, et l'on garde cette
      // derniere trame dans _prec : l'intervalle qui enjambe la frontiere
      // s'interpole alors entre _prec et le premier echantillon du bloc
      // suivant, au lieu de tenir une valeur. _pos devient negatif le temps
      // de cet intervalle, et l'indice -1 designe _prec.
      if (this._pos >= this._reste - 1) {
        if (this._reste > 0) {
          if (!this._prec || this._prec.length !== nCanaux) this._prec = new Float32Array(nCanaux);
          for (let k = 0; k < nCanaux; k++) this._prec[k] = lire(this._reste - 1, k);
          this._pos -= this._reste;
        }
        if (c._libvgmstream_render(this.lib) < 0) { fini = true; break; }
        const dec = c.getValue(this.lib + LIB_DECODER_PTR, '*');
        this._bufPtr = c.getValue(dec + DEC_BUF, '*');
        this._reste = c.getValue(dec + DEC_BUF_SAMPLES, 'i32');
        if (c.getValue(dec + DEC_DONE, 'i8')) fini = true;
        // Plus rien a rendre : c'est une fin, et il faut le DIRE. Sortir
        // sans lever ce drapeau laissait le morceau fige sur sa derniere
        // position, a emettre du silence sans jamais rendre la main.
        if (this._reste <= 0) { fini = true; break; }
        // Un bloc trop court pour contenir la position reportee : on repart de
        // son debut plutot que de sauter en avant.
        if (this._pos >= this._reste - 1) this._pos = 0;
      }
      const i0 = Math.floor(this._pos);
      const frac = this._pos - i0;
      for (let ch = 0; ch < channels.length; ch++) {
        const k = Math.min(ch, nCanaux - 1);
        const a = i0 < 0 ? (this._prec ? this._prec[k] : 0) : lire(i0, ch);
        const b = lire(i0 + 1, ch);
        channels[ch][ecrits] = a + (b - a) * frac;
      }
      this._pos += pas;
      ecrits++;
    }

    if (ecrits < attendus) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0, ecrits);
    }
    // La fin se signale des qu'elle est connue, et non seulement quand le
    // tampon repart vide.
    //
    // CE QUE CETTE LIGNE VALAIT AVANT. Releve sur un .adx de 4,26 s en
    // production : a 4 260 ms la position se figeait, la crete tombait a
    // 0,0007, et handleSongEnd n'etait JAMAIS appele — ni avance au morceau
    // suivant, ni ejection. Le lecteur restait charge, muet, indefiniment.
    // Le decodeur avait pourtant leve son drapeau « done » sur un tampon
    // qu'il avait rempli en partie, et la condition « ecrits === 0 » rejetait
    // ce cas-la, le plus courant de tous.
    // ET UNE BORNE QUI NE DEPEND D'AUCUN DRAPEAU.
    //
    // Le drapeau « done » du decodeur ne suffit pas toujours. Releve sur un
    // .adx de 30 s en production : arrive a sa borne, la position restait
    // collee a 29 998 ms — soit exactement la duree annoncee — tandis que le
    // decodeur rendait encore des blocs de 67 echantillons sans jamais se
    // declarer termine. Rien ne venait donc conclure le morceau.
    //
    // play_samples, dont vient cette duree, est deja calcule par vgmstream
    // APRES application de la boucle et du fondu : l'atteindre, c'est etre a
    // la fin. On s'en sert comme garde-fou, et l'on exige deux tampons sans
    // progression pour ne pas couper sur un simple arrondi.
    if (!fini && this._dureeMs > 0 && this.getPositionMs() >= this._dureeMs) {
      if (++this._surPlace >= 2) fini = true;
    } else {
      this._surPlace = 0;
    }

    if (fini && !this._termine) {
      this._termine = true;
      this.handleSongEnd();
    }
  }

  getMetadata() { return this.metadata || {}; }

  getInfoTexts() { return this.infoTexts; }

  getDurationMs() { return this._dureeMs; }

  getPositionMs() {
    if (!this.lib || !this._tauxFichier) return 0;
    const ech = Number(this.core._libvgmstream_get_play_position(this.lib));
    return (ech / this._tauxFichier) * 1000;
  }

  seekMs(ms) {
    if (!this.lib || !this._tauxFichier) return;
    const ech = Math.max(0, Math.round((ms / 1000) * this._tauxFichier));
    // libvgmstream_seek prend un int64_t. La colle emscripten est reliee avec
    // WASM_BIGINT : un entier 64 bits traverse la frontiere en BigInt, et lui
    // passer un Number leve « Cannot convert 800000 to a BigInt » — le pendant
    // du Number() que getPositionMs applique au retour.
    this.core._libvgmstream_seek(this.lib, BigInt(ech));
    // Le bloc deja decode date d'avant le saut : le relacher, faute de quoi on
    // rejouerait un fragment de l'ancienne position. _prec aussi, sans quoi la
    // premiere trame apres le saut s'interpolerait depuis l'ancien endroit.
    this._reste = 0;
    this._pos = 0;
    this._prec = null;
    this._termine = false;
    this._surPlace = 0;
  }

  getNumSubtunes() { return this._nbSubtunes; }

  getSubtune() { return this._subtune; }

  playSubtune(subtune) {
    // Les sous-pistes de vgmstream sont des flux distincts : il faut rouvrir.
    // On garde les octets d'origine, le sequenceur ne les redonnera pas.
    this._subtune = subtune;
    if (this._donnees && this._nomFichier) {
      this.loadData(this._donnees, this._nomFichier).catch(e => this.emit('playerError', e.message));
    }
  }

  isPlaying() { return !this.isPaused() && !this.stopped; }

  stop() {
    this.suspend();
    this._nettoyer();
    this._garderVoisins(new Set());
    this._subtune = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
