import Player from './Player.js';
import { ensureEmscFileWithData, pathJoin } from '../util';
import { CATALOG_PREFIX } from '../config';
import pathe from 'pathe';
import autoBind from 'auto-bind';

// La famille *Sound Format*, moins la part qui demande d'autres machines.
//
// Un .psf, un .ssf et un .dsf sont le MEME conteneur : seul l'octet 3 change,
// et c'est lui qui designe la machine a simuler. Les variantes « mini » ne
// different en rien du point de vue du format — le prefixe signale seulement,
// par convention, que le fichier ne tient debout qu'avec sa bibliotheque.
//
// Hors perimetre pour l'instant : psf2 (PlayStation 2), qui demande en plus le
// systeme de fichiers virtuel psf2fs ; 2sf, gsf, snsf, qsf, ncsf, qui sont
// d'autres machines encore, chacune avec son emulateur.
const fileExtensions = ['psf', 'minipsf', 'ssf', 'minissf', 'dsf', 'minidsf'];

const MOUNTPOINT = '/psf';

// Octet 3 de l'en-tete PSF. Les deux coeurs embarques couvrent ceux-ci.
const TYPE_PSF1 = 0x01;
const TYPE_SSF = 0x11;
const TYPE_DSF = 0x12;
const TYPES_CONNUS = {
  [TYPE_PSF1]: 'PlayStation',
  [TYPE_SSF]: 'Sega Saturn',
  [TYPE_DSF]: 'Dreamcast',
};

// Ou trouver les images de BIOS deposees par l'administrateur. Le manifeste
// est ecrit au demarrage du conteneur par bios-manifest.js, cote stack : un
// navigateur ne peut pas lister un dossier servi en statique, et deviner le
// nom du fichier mettrait l'utilisateur en echec sans qu'il sache pourquoi.
const BIOS_MANIFESTE = '/bios-manifest.json';
const BIOS_DOSSIER = '/bios/';

// Bornes que psx_init() impose : il s'arrete net si la taille n'est pas une
// puissance de deux. Un BIOS de PlayStation fait 512 ko.
const BIOS_TAILLE_MIN = 256 * 1024;
const BIOS_TAILLE_MAX = 8 * 1024 * 1024;

// CE QU'IL FAUT : UNE IMAGE « HE BIOS », PAS UN BIOS DE PLAYSTATION
//
// Highly_Experimental ne se contente pas d'une ROM de console : il lit des
// variables de configuration DANS l'image, a l'offset 0x80, derriere une
// banniere qui les annonce. psx_init() fait
//
//     if(bios_getenv("ps1preboot", s, sizeof(s))) psx_hang("getenv failed");
//
// et psx_hang() est « for(;;) { *((volatile char*)0) = *message; } ». Une
// image sans cette banniere ne donne donc pas une erreur mais une BOUCLE
// INFINIE, avant meme que le moteur ait commence — l'onglet se fige, sans
// message, et l'on ne peut pas interrompre du wasm depuis JavaScript.
//
// On verifie donc EXACTEMENT ce que le coeur exigera, au meme endroit. Ce
// n'est plus une ressemblance, c'est la condition elle-meme.
//
// Ces images se fabriquent avec l'outil mkhebios du depot amont, a partir d'un
// BIOS de PlayStation 2 : voir bios/README.md cote pile.
const BIOS_BANNIERE = 'Highly Experimental';
const BIOS_BANNIERE_OFFSET = 0x80;

// L'autre forme acceptee : un BIOS de PlayStation 2 brut, que mkhebios
// convertit a la volee. Exactement 4 Mo, et les octets que le script de
// conversion attend aux deux endroits qu'il corrige.
const BIOS_PS2_TAILLE = 4 * 1024 * 1024;
const BIOS_PS2_SIGNATURES = [
  { offset: 0x52360, octets: 'dc34f10f07000424' },            // preamorçage PS1
  { offset: 0x4A448, octets: '0000000009f8400021206002' },    // preamorçage PS2
];

// Les deux coeurs rendent a cette cadence, sans reglage possible : c'est celle
// des machines qu'ils simulent.
const TAUX_MOTEUR = 44100;

// Duree retenue quand le fichier n'en declare pas. La plupart en declarent une
// (etiquette `length`), les rips de cette famille etant soigneusement tagues.
const DUREE_DEFAUT_MS = 150000;

// Une recherche se paie en reemulation depuis le debut : la borne evite qu'un
// clic en fin de barre parte pour un fichier a duree aberrante.
const SECONDES_RECHERCHE_MAX = 900;

// Temps accorde au rattrapage a chaque appel du rendu audio.
//
// Une recherche ne peut pas se faire d'un bloc : reemuler quatre-vingt-dix
// secondes de Dreamcast prend neuf secondes, mesurees — autant de gel complet
// de l'onglet, barre de progression comprise. On etale donc le travail sur les
// appels successifs, vingt millisecondes a la fois sur les quarante-deux que
// dure un tampon de 2048 echantillons a 48 kHz. La page reste vivante, et le
// rattrapage avance a cinq ou six fois le temps reel sur Dreamcast, davantage
// sur Saturn.
//
// Un budget en MILLISECONDES et non en echantillons : les deux machines ne
// vont pas a la meme vitesse, et la machine de l'utilisateur non plus.
const MS_RATTRAPAGE_PAR_APPEL = 20;

// Profondeur maximale de la chaine _lib. Trois suffisent largement — le record
// observe au catalogue est de trois niveaux, sur les rips de Wild Arms — et la
// borne protege d'un cycle entre deux fichiers qui se renverraient l'un a
// l'autre.
const PROFONDEUR_LIB_MAX = 8;

/**
 * Lecteur de la famille *Sound Format* : PlayStation, Saturn, Dreamcast.
 *
 * CE QUE CE LECTEUR N'EST PAS
 *
 * Il ne decode rien. Un .psf ne contient pas de son mais le PROGRAMME que la
 * console executait pour piloter sa puce audio, plus les echantillons dont il
 * se sert. Le lire demande donc de simuler la machine. C'est pourquoi ces
 * extensions avaient ete retirees du catalogue plutot que confiees a
 * vgmstream : celui-ci revendique bien « psf », « ssf » et « dsf », mais pour
 * de tout autres formats qui portent le meme nom — un .psf de Pivotal Games
 * n'a rien d'un PlayStation Sound Format.
 *
 * LA PLAYSTATION DEMANDE UNE ROM
 *
 * Saturn et Dreamcast jouent sans rien reclamer. La PlayStation, non : le
 * coeur Highly_Experimental exige une image de BIOS Sony, que son auteur ne
 * distribue pas davantage que nous — « The unfortunate dirty secret here is
 * that Sony BIOS is used », dit son Readme, qui range l'emulation de haut
 * niveau au rayon des choses a faire.
 *
 * Elle vient donc de l'administrateur, qui depose la sienne dans le dossier
 * bios/ de la pile. _assurerBios() va la chercher au premier .psf ouvert.
 *
 * DEUX PIEGES, TOUS DEUX SILENCIEUX ET COUTEUX
 *
 * 1. Sans BIOS, psx_init() rend ZERO, c'est-a-dire son code de SUCCES. Rien
 *    n'est initialise, et le R3000 part executer de la memoire vide.
 * 2. Avec une MAUVAISE image, meme chose : le coeur la mappe a 0x1FC00000 et
 *    execute ce qu'il y trouve.
 *
 * Dans les deux cas l'onglet se fige, sans message et sans erreur — on ne peut
 * pas interrompre du wasm depuis JavaScript. D'ou deux garde-fous : le shim
 * verifie la presence du BIOS avant d'appeler quoi que ce soit, et ce lecteur
 * controle la vraisemblance de l'image avant de l'installer.
 *
 * LES BIBLIOTHEQUES VOISINES
 *
 * Un morceau de cette famille pese souvent quelques centaines d'octets : tout
 * le reste — le pilote audio du jeu, ses instruments — vit dans un fichier
 * .psflib/.ssflib/.dsflib partage par toutes les pistes, designe par les
 * etiquettes _lib, _lib2, _lib3. Ces bibliotheques sont elles-memes des
 * conteneurs PSF et peuvent en designer d'autres.
 *
 * Le lecteur les depose donc dans le systeme de fichiers d'emscripten AVANT
 * d'ouvrir le morceau, en les tirant du catalogue par HTTP — exactement ce que
 * N64Player fait pour les .usflib. psflib se charge ensuite de la recursion et
 * de l'ordre de superposition.
 */
export default class PSFPlayer extends Player {
  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : charge au premier fichier.
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'psf';
    this.name = 'PSF Player';
    this.fileExtensions = fileExtensions;
    this.buf = 0;
    this._ouvert = false;
    this._type = 0;
    this._echantillons = 0;   // rendus, a la cadence de SORTIE
    this._dureeMs = DUREE_DEFAUT_MS;
    this._fichierFs = null;
    // Reechantillonnage : meme principe que VGMStreamPlayer, les coeurs
    // rendant a 44 100 Hz quelle que soit la cadence du contexte audio.
    this._reste = 0;
    this._pos = 0;
    this._prec = null;
    this._aRattraper = 0;   // echantillons MOTEUR restant a traverser en silence
    this.infoTexts = [];
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../psf');
    this.core = await mod.default();
    try { this.core.FS.mkdir(MOUNTPOINT); } catch (e) { /* existe deja */ }
    // Tampon de rendu : stereo 16 bits. Large, pour absorber le rapport de
    // cadences quand la sortie tourne plus vite que 44 100 Hz.
    this._capacite = this.bufferSize * 2 + 64;
    this.buf = this.core._malloc(this._capacite * 2 * 2);
  }

  /**
   * Charge, verifie et installe l'image de BIOS que reclame la PlayStation.
   *
   * L'image vient du dossier ./bios de la pile, servi sous /bios, et le
   * manifeste ecrit au demarrage du conteneur dit ce qui s'y trouve. On essaie
   * les images dans l'ordre et l'on retient la premiere qui passe le controle.
   *
   * Le resultat est garde : le BIOS s'installe une fois pour la session.
   */
  async _assurerBios() {
    if (this.core._psfx_a_bios()) return;

    let manifeste;
    try {
      const r = await fetch(BIOS_MANIFESTE);
      if (!r.ok) throw Error(String(r.status));
      manifeste = await r.json();
    } catch (e) {
      throw Error('psf : la PlayStation demande une image de BIOS. Deposez-en '
        + 'une dans le dossier bios/ de la pile, puis redemarrez (voir bios/README.md).');
    }

    const images = (manifeste && manifeste.images) || [];
    if (images.length === 0) {
      throw Error('psf : aucune image de BIOS dans le dossier bios/. '
        + 'Deposez-y celle de votre PlayStation, puis redemarrez la pile.');
    }

    const refus = [];
    for (const image of images) {
      let octets;
      try {
        const r = await fetch(BIOS_DOSSIER + encodeURIComponent(image.nom));
        if (!r.ok) { refus.push(`${image.nom} : illisible (${r.status})`); continue; }
        octets = new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        refus.push(`${image.nom} : illisible`);
        continue;
      }

      const probleme = this._verifierBios(octets);
      if (probleme) { refus.push(`${image.nom} : ${probleme}`); continue; }

      // Le coeur garde le pointeur : la memoire doit rester a lui pour toute
      // la duree de la session, on ne la libere donc jamais.
      const ptr = this.core._malloc(octets.length);
      this.core.HEAPU8.set(octets, ptr);

      if (image.type === 'ps2') {
        // Une ROM de PlayStation 2 : mkhebios la depouille et en tire l'image
        // que le coeur attend. L'operation prend un instant et ne se fait
        // qu'une fois par session.
        const taille = this.core._psfx_set_bios_ps2(ptr, octets.length);
        if (taille > 0 && this.core._psfx_a_bios()) return;
        this.core._free(ptr);
        refus.push(`${image.nom} : conversion du BIOS PlayStation 2 refusee par mkhebios`);
        continue;
      }

      this.core._psfx_set_bios(ptr, octets.length);
      if (this.core._psfx_a_bios()) return;
      refus.push(`${image.nom} : refusee par le moteur`);
    }

    throw Error('psf : aucune image de BIOS utilisable — ' + refus.join(' ; '));
  }

  /** Rend null si l'image est plausible, sinon la raison du refus. */
  _verifierBios(octets) {
    const n = octets.length;
    if (n < BIOS_TAILLE_MIN || n > BIOS_TAILLE_MAX) {
      return `${Math.round(n / 1024)} ko, hors des bornes attendues`;
    }
    if (n & (n - 1)) {
      return `${Math.round(n / 1024)} ko, ce n'est pas une puissance de deux`;
    }
    const zone = new TextDecoder('latin1').decode(
      octets.subarray(BIOS_BANNIERE_OFFSET, BIOS_BANNIERE_OFFSET + BIOS_BANNIERE.length));
    if (zone === BIOS_BANNIERE) return null;
    if (this._estBiosPs2(octets)) return null;
    return 'ni une image HE BIOS, ni un BIOS PlayStation 2 convertible';
  }

  /**
   * Un BIOS de PlayStation 2 que mkhebios saura convertir ?
   *
   * Les deux signatures sont la condition EXACTE de reussite : le script de
   * conversion corrige ces deux endroits et compare les octets avant d'ecrire,
   * renonçant en cas d'ecart. Les verifier ici, c'est donc savoir d'avance si
   * la conversion aboutira — et non s'en remettre a l'essai.
   */
  _estBiosPs2(octets) {
    if (octets.length !== BIOS_PS2_TAILLE) return false;
    return BIOS_PS2_SIGNATURES.every(({ offset, octets: attendu }) => {
      let hex = '';
      for (let i = 0; i < attendu.length / 2; i++) {
        hex += octets[offset + i].toString(16).padStart(2, '0');
      }
      return hex === attendu;
    });
  }

  /**
   * Lit le bloc d'etiquettes d'un conteneur PSF, sans le decompresser.
   *
   * L'en-tete fait seize octets : « PSF », l'octet de version, puis la taille
   * de la zone reservee et celle du programme compresse. Les etiquettes
   * suivent, derriere un marqueur « [TAG] ». On n'a besoin que de celles-ci
   * pour savoir quelles bibliotheques aller chercher — inutile de decompresser
   * quoi que ce soit a ce stade.
   */
  _etiquettes(octets) {
    if (octets.length < 16) return {};
    if (octets[0] !== 0x50 || octets[1] !== 0x53 || octets[2] !== 0x46) return {};
    const u32 = o => (octets[o] | (octets[o + 1] << 8) | (octets[o + 2] << 16) | (octets[o + 3] << 24)) >>> 0;
    const debut = 16 + u32(4) + u32(8);
    if (debut >= octets.length) return {};
    const texte = new TextDecoder('latin1').decode(octets.subarray(debut));
    if (!texte.startsWith('[TAG]')) return {};
    const etiquettes = {};
    for (const ligne of texte.slice(5).split('\n')) {
      const i = ligne.indexOf('=');
      if (i > 0) etiquettes[ligne.slice(0, i).trim().toLowerCase()] = ligne.slice(i + 1).trim();
    }
    return etiquettes;
  }

  _libsDe(etiquettes) {
    // _lib, puis _lib2, _lib3… C'est l'ordre dans lequel psflib les empile.
    const libs = [];
    if (etiquettes._lib) libs.push(etiquettes._lib);
    for (let i = 2; ; i++) {
      const v = etiquettes['_lib' + i];
      if (!v) break;
      libs.push(v);
    }
    return libs;
  }

  /**
   * Depose le fichier et toute sa chaine de bibliotheques dans le systeme de
   * fichiers d'emscripten.
   *
   * La recursion se fait ICI, cote JavaScript, et non dans psflib : celui-ci
   * ouvrirait les bibliotheques par son rappel fopen, qui est synchrone, alors
   * que les tirer du catalogue demande un aller-retour reseau. On resout donc
   * la chaine d'abord, on ecrit tout, et psflib n'a plus qu'a lire des
   * fichiers deja presents.
   */
  async _deposerAvecLibs(octets, chemin) {
    const dossier = pathe.dirname(chemin);
    const vus = new Set();

    const deposer = async (nom, donnees, profondeur) => {
      if (profondeur > PROFONDEUR_LIB_MAX) {
        throw Error('psf : chaine _lib trop profonde (cycle ?)');
      }
      const cle = nom.toLowerCase();
      if (vus.has(cle)) return;
      vus.add(cle);

      await ensureEmscFileWithData(this.core, pathJoin(MOUNTPOINT, dossier, nom), donnees, true);

      for (const lib of this._libsDe(this._etiquettes(donnees))) {
        if (vus.has(lib.toLowerCase())) continue;
        const url = pathJoin(CATALOG_PREFIX, dossier, lib);
        const reponse = await fetch(url);
        if (!reponse.ok) {
          throw Error(`psf : bibliotheque « ${lib} » introuvable (${reponse.status})`);
        }
        await deposer(lib, new Uint8Array(await reponse.arrayBuffer()), profondeur + 1);
      }
    };

    await deposer(pathe.basename(chemin), octets, 0);
    return pathJoin(MOUNTPOINT, chemin);
  }

  /** « 2:08 », « 1:02.5 » ou « 95 » -> millisecondes. */
  _dureeDepuisEtiquette(valeur) {
    if (!valeur) return 0;
    const parts = String(valeur).trim().split(':').map(parseFloat);
    if (parts.some(isNaN)) return 0;
    const secondes = parts.reduce((acc, p) => acc * 60 + p, 0);
    return Math.round(secondes * 1000);
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    this._fermer();

    const type = this.core._psfx_type_of
      ? (data.length >= 4 && data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x46 ? data[3] : 0)
      : 0;
    if (type === 0x02) {
      throw Error('psf : la PlayStation 2 (PSF2) n\'est pas prise en charge par ce moteur');
    }
    if (type === TYPE_PSF1) {
      // On s'assure du BIOS AVANT d'entrer dans le wasm. Voir l'en-tete de ce
      // fichier : le coeur PlayStation sans BIOS valable ne rend pas la main.
      await this._assurerBios();
    }
    if (!TYPES_CONNUS[type]) {
      throw Error(`psf : type 0x${type.toString(16)} non pris en charge par ce moteur`);
    }

    const cheminFs = await this._deposerAvecLibs(data, filename);
    this._fichierFs = cheminFs;

    const ptr = this.core._malloc(this.core.lengthBytesUTF8(cheminFs) + 1);
    this.core.stringToUTF8(cheminFs, ptr, this.core.lengthBytesUTF8(cheminFs) + 1);
    const r = this.core._psfx_open(ptr, type);
    this.core._free(ptr);
    if (r !== 0) throw Error(`psf : ouverture refusee (code ${r})`);

    this._ouvert = true;
    this._type = type;
    this._echantillons = 0;
    this._reste = 0; this._pos = 0; this._prec = null; this._aRattraper = 0;

    this._lireMetadonnees();
    this.resolveParamValues(persistedSettings);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  _lireMetadonnees() {
    const brut = this.core.UTF8ToString(this.core._psfx_tags());
    const t = {};
    for (const ligne of brut.split('\n')) {
      const i = ligne.indexOf('=');
      if (i > 0) t[ligne.slice(0, i).trim().toLowerCase()] = ligne.slice(i + 1).trim();
    }

    // `length` donne la duree du morceau, `fade` celle du fondu qui la suit :
    // les deux se cumulent, c'est ce que le format prescrit.
    const duree = this._dureeDepuisEtiquette(t.length);
    const fondu = this._dureeDepuisEtiquette(t.fade);
    this._dureeMs = duree ? duree + fondu : DUREE_DEFAUT_MS;

    this.metadata = {
      title: t.title || this.filepathMeta.title,
      artist: t.artist || '',
      game: t.game || '',
      date: t.year || '',
      system: TYPES_CONNUS[this._type],
      copyright: t.copyright || '',
      play_length: this._dureeMs,
    };

    const textes = [];
    if (t.comment) textes.push(t.comment);
    const parQui = t.psfby || t.ssfby || t.dsfby;
    if (parQui) textes.push('Rip: ' + parQui);
    this.infoTexts = textes.length ? [textes.join('\n')] : [];
  }

  _fermer() {
    if (this.core && this._ouvert) this.core._psfx_close();
    this._ouvert = false;
  }

  _lire(indice, canal) {
    const i = (this.buf >> 1) + indice * 2 + Math.min(canal, 1);
    return this.core.HEAP16[i] / 32768;
  }

  /**
   * Rendu, avec reechantillonnage de 44 100 Hz vers la cadence du contexte.
   *
   * Meme traitement de frontiere que VGMStreamPlayer : on change de bloc un
   * echantillon avant la fin et l'on garde la derniere trame dans _prec, pour
   * que l'intervalle a cheval s'interpole au lieu de tenir une valeur — ce qui
   * ferait entendre un bourdonnement a la cadence des blocs.
   */
  processAudioInner(channels) {
    if (this.paused || !this._ouvert) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const c = this.core;
    const attendus = channels[0].length;
    const pas = TAUX_MOTEUR / this.sampleRate;
    let ecrits = 0;
    let fini = false;

    // Rattrapage d'une recherche : on fait tourner la machine en jetant le
    // son, par tranches de temps, et l'on rend du silence pendant ce temps-la.
    // La position affichee, elle, est deja celle qu'on vise : l'utilisateur
    // voit le curseur ou il l'a mis, et la musique le rejoint.
    if (this._aRattraper > 0) {
      const limite = performance.now() + MS_RATTRAPAGE_PAR_APPEL;
      while (this._aRattraper > 0 && performance.now() < limite) {
        const n = c._psfx_render(this.buf, Math.min(this._capacite, this._aRattraper));
        if (n <= 0) { this._aRattraper = 0; break; }
        this._aRattraper -= n;
      }
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    while (ecrits < attendus) {
      if (this._pos >= this._reste - 1) {
        if (this._reste > 0) {
          if (!this._prec) this._prec = new Float32Array(2);
          this._prec[0] = this._lire(this._reste - 1, 0);
          this._prec[1] = this._lire(this._reste - 1, 1);
          this._pos -= this._reste;
        }
        const n = c._psfx_render(this.buf, this._capacite);
        if (n <= 0) { fini = true; break; }
        this._reste = n;
        if (this._pos >= this._reste - 1) this._pos = 0;
      }
      const i0 = Math.floor(this._pos);
      const frac = this._pos - i0;
      for (let ch = 0; ch < channels.length; ch++) {
        const a = i0 < 0 ? (this._prec ? this._prec[Math.min(ch, 1)] : 0) : this._lire(i0, ch);
        const b = this._lire(i0 + 1, ch);
        channels[ch][ecrits] = a + (b - a) * frac;
      }
      this._pos += pas;
      ecrits++;
    }

    if (ecrits < attendus) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0, ecrits);
    }
    this._echantillons += ecrits;

    // Ni l'un ni l'autre des deux coeurs ne sait dire qu'un morceau est fini :
    // ils executent un programme, et ce programme boucle. C'est l'etiquette
    // `length` qui fait foi, comme chez tous les lecteurs de cette famille.
    if (this._echantillons / this.sampleRate >= this._dureeMs / 1000) fini = true;
    if (fini) this.handleSongEnd();
  }

  getMetadata() { return this.metadata || {}; }

  getInfoTexts() { return this.infoTexts; }

  getDurationMs() { return this._dureeMs; }

  getPositionMs() { return (this._echantillons / this.sampleRate) * 1000; }

  /**
   * Recherche par reemulation depuis le debut.
   *
   * Comme pour le KSS, il n'y a pas de position a poser : l'etat du morceau
   * tient dans la memoire de la machine simulee. On rouvre donc le fichier et
   * on fait tourner le processeur jusqu'a l'instant vise, en jetant le son
   * produit. Aller en arriere coute exactement le meme prix qu'aller en avant.
   */
  seekMs(ms) {
    if (!this._ouvert || !this._fichierFs) return;
    const cible = Math.max(0, Math.min(ms, SECONDES_RECHERCHE_MAX * 1000));

    const c = this.core;
    const ptr = c._malloc(c.lengthBytesUTF8(this._fichierFs) + 1);
    c.stringToUTF8(this._fichierFs, ptr, c.lengthBytesUTF8(this._fichierFs) + 1);
    const r = c._psfx_open(ptr, this._type);
    c._free(ptr);
    if (r !== 0) { this._ouvert = false; return; }

    this._reste = 0; this._pos = 0; this._prec = null;
    // On ne reemule RIEN ici : c'est processAudioInner qui traversera la
    // distance, par tranches, sans bloquer la page. Voir MS_RATTRAPAGE_PAR_APPEL.
    this._aRattraper = Math.round((cible / 1000) * TAUX_MOTEUR);
    this._echantillons = Math.round((cible / 1000) * this.sampleRate);
  }

  // Un fichier de cette famille porte un seul morceau : la piste est choisie a
  // l'extraction, pas a la lecture.
  getNumSubtunes() { return 1; }

  getSubtune() { return 0; }

  stop() {
    this.suspend();
    this._fermer();
    this._echantillons = 0;
    this._aRattraper = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
