import Player from './Player.js';
import autoBind from 'auto-bind';

// Cartouches PICO-8 : .p8 (texte) et .p8.png (image). « p8.png » est une
// extension composee, reconnue par extensionOf() dans src/config.
const fileExtensions = ['p8', 'p8.png'];

// PICO-8 produit son son a 22 050 Hz ; on le reechantillonne vers la cadence
// du contexte audio. Le moteur avance par images de 1/60 s, et son
// synthetiseur par paquets : on suit exactement le rythme du coeur libretro de
// FAKE-08 — deux Step() pour 735 echantillons.
const TAUX_PICO8 = 22050;
const ECHANTILLONS_PAR_PAQUET = 735;   // 1/30 s
const STEPS_PAR_PAQUET = 2;            // deux images a 60 Hz

// Une cartouche n'a pas de fin : c'est un programme, et une demo boucle
// indefiniment. Comme pour les rips sans etiquette de duree, on en joue une
// duree fixe avant de passer au morceau suivant (Repeat One la prolonge).
const DUREE_DEFAUT_MS = 180000;

// Rattrapage d'une recherche : on refait tourner la cartouche depuis le debut
// en jetant le son, par tranches de temps, pour ne pas figer la page.
const MS_RATTRAPAGE_PAR_APPEL = 20;
const SECONDES_RECHERCHE_MAX = 900;

/**
 * Lecteur de cartouches PICO-8, par FAKE-08 (MIT) compile en WebAssembly.
 *
 * CE QUE CE LECTEUR EST
 *
 * PICO-8 est une console imaginaire : une cartouche est un PROGRAMME Lua, qui
 * dessine sur un ecran de 128 x 128 et pilote un synthetiseur a quatre voix.
 * Beaucoup de cartouches ne sont que de la musique ou des demos ; pour les
 * entendre, il faut executer le programme. FAKE-08 le fait, sans rien de
 * PICO-8 lui-meme — il n'a aucun lien avec Lexaloffle.
 *
 * L'ECRAN
 *
 * Le programme tourne meme quand on ne le regarde pas : c'est lui qui joue la
 * musique. getScreen() rend l'image courante ; le visualiseur l'affiche a la
 * place du spectrogramme (voir components/Visualizer.js). Sans
 * manette, une cartouche de jeu reste sur son ecran-titre — ce qui convient a
 * un lecteur : on y entend la musique du titre.
 */
export default class Pico8Player extends Player {
  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : charge au premier fichier.
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'pico8';
    this.name = 'PICO-8 Player';
    this.fileExtensions = fileExtensions;
    this.hasScreen = true;
    this._ouvert = false;
    this._donnees = 0;        // la cartouche, dans le tas du wasm
    this._taille = 0;
    this._echantillons = 0;   // rendus, a la cadence de SORTIE
    this._dureeMs = DUREE_DEFAUT_MS;
    this._reste = 0;
    this._pos = 0;
    this._prec = null;
    this._aRattraper = 0;     // paquets restant a traverser en silence
    this._image = null;       // Uint8ClampedArray 128 x 128 RGBA
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../fake08');
    this.core = await mod.default();
    this.core._f8_init();
    this.buf = this.core._malloc(ECHANTILLONS_PAR_PAQUET * 4);
    this.ecran = this.core._malloc(128 * 128 * 4);
  }

  _titreDepuisLaCartouche(data, filename) {
    // Convention PICO-8 : les deux premieres lignes de commentaire du code
    // donnent le titre et l'auteur. Lisible seulement dans un .p8 texte ; un
    // .p8.png est compresse.
    const nom = (filename || '').split('/').pop().replace(/\.p8(\.png)?$/i, '');
    if (data.length < 4 || data[0] === 0x89) return { title: nom, artist: '' };
    const texte = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 4096)));
    const lua = texte.split('__lua__')[1];
    if (!lua) return { title: nom, artist: '' };
    const commentaires = [];
    for (const ligne of lua.split('\n')) {
      const l = ligne.trim();
      if (!l) continue;
      if (!l.startsWith('--')) break;
      commentaires.push(l.replace(/^-+\s*/, '').trim());
      if (commentaires.length === 2) break;
    }
    // « -- by quelqu'un » : on garde le nom, pas la preposition.
    const auteur = (commentaires[1] || '').replace(/^by\s+/i, '');
    return { title: commentaires[0] || nom, artist: auteur };
  }

  _ouvrir() {
    const c = this.core;
    const r = c._f8_load(this._donnees, this._taille);
    if (r !== 0) {
      throw Error('pico-8 : ' + (c.UTF8ToString(c._f8_error()) || 'cartouche illisible'));
    }
    this._ouvert = true;
    this._reste = 0; this._pos = 0; this._prec = null;
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    const c = this.core;

    // La cartouche reste dans le tas tant qu'elle est chargee : le moteur
    // garde des pointeurs dessus, et une recherche la recharge.
    if (this._donnees) c._free(this._donnees);
    this._taille = data.length;
    this._donnees = c._malloc(data.length);
    c.HEAPU8.set(data, this._donnees);

    this._ouvrir();
    this._echantillons = 0;
    this._aRattraper = 0;
    this._dureeMs = DUREE_DEFAUT_MS;

    const { title, artist } = this._titreDepuisLaCartouche(data, filename);
    this.metadata = {
      title,
      artist,
      game: '',
      system: 'PICO-8',
      copyright: '',
      play_length: this._dureeMs,
    };
    this.infoTexts = [];

    this.resolveParamValues(persistedSettings);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  // Un paquet : deux images, puis 735 echantillons. Rend false si la
  // cartouche s'est arretee (fin du programme ou erreur).
  _paquet() {
    const c = this.core;
    for (let i = 0; i < STEPS_PAR_PAQUET; i++) {
      const r = c._f8_step();
      if (r === -2) {
        console.warn('pico-8 :', c.UTF8ToString(c._f8_error()));
        return false;
      }
    }
    c._f8_audio(this.buf, ECHANTILLONS_PAR_PAQUET);
    return true;
  }

  _lire(indice, canal) {
    return this.core.HEAP16[(this.buf >> 1) + indice * 2 + Math.min(canal, 1)] / 32768;
  }

  processAudioInner(channels) {
    if (this.paused || !this._ouvert) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    if (this._aRattraper > 0) {
      const limite = performance.now() + MS_RATTRAPAGE_PAR_APPEL;
      while (this._aRattraper > 0 && performance.now() < limite) {
        if (!this._paquet()) { this._aRattraper = 0; break; }
        this._aRattraper--;
      }
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const attendus = channels[0].length;
    const pas = TAUX_PICO8 / this.sampleRate;
    let ecrits = 0;
    let fini = false;

    while (ecrits < attendus) {
      if (this._pos >= this._reste - 1) {
        if (this._reste > 0) {
          if (!this._prec) this._prec = new Float32Array(2);
          this._prec[0] = this._lire(this._reste - 1, 0);
          this._prec[1] = this._lire(this._reste - 1, 1);
          this._pos -= this._reste;
        }
        if (!this._paquet()) { fini = true; break; }
        this._reste = ECHANTILLONS_PAR_PAQUET;
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
    if (this._echantillons / this.sampleRate >= this._dureeMs / 1000) fini = true;
    if (fini) this.handleSongEnd();
  }

  /**
   * L'ecran courant, 128 x 128 RGBA, ou null sans cartouche. Le tableau rendu
   * est reutilise d'un appel a l'autre : a copier si on veut le garder.
   */
  getScreen() {
    if (!this.core || !this._ouvert) return null;
    this.core._f8_screen(this.ecran);
    if (!this._image) this._image = new Uint8ClampedArray(128 * 128 * 4);
    this._image.set(this.core.HEAPU8.subarray(this.ecran, this.ecran + 128 * 128 * 4));
    return this._image;
  }

  getMetadata() { return this.metadata || {}; }

  getInfoTexts() { return this.infoTexts; }

  getDurationMs() { return this._dureeMs; }

  getPositionMs() { return (this._echantillons / this.sampleRate) * 1000; }

  // Recherche : on recharge la cartouche et l'on refait tourner le programme
  // jusqu'a l'instant vise, en jetant le son — l'etat d'une demo tient dans
  // sa memoire, il n'y a pas de position a poser.
  seekMs(ms) {
    if (!this._ouvert || !this._donnees) return;
    const cible = Math.max(0, Math.min(ms, SECONDES_RECHERCHE_MAX * 1000));
    try { this._ouvrir(); } catch (e) { this._ouvert = false; return; }
    this._aRattraper = Math.round((cible / 1000) * (TAUX_PICO8 / ECHANTILLONS_PAR_PAQUET));
    this._echantillons = Math.round((cible / 1000) * this.sampleRate);
  }

  getNumSubtunes() { return 1; }

  getSubtune() { return 0; }

  stop() {
    this.suspend();
    if (this.core && this._ouvert) this.core._f8_close();
    this._ouvert = false;
    this._echantillons = 0;
    this._aRattraper = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
