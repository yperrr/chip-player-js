import Player from './Player.js';
import autoBind from 'auto-bind';

const fileExtensions = ['tic'];

// L'ecran de TIC-80 avec sa bordure : 240 x 136 au centre d'un cadre de
// 256 x 144, dont la couleur fait partie de l'image d'une demo.
const LARGEUR = 256;
const HAUTEUR = 144;

// Une cartouche n'a pas de fin : comme pour PICO-8, on en joue une duree fixe
// avant de passer au morceau suivant (Repeat One la prolonge).
const DUREE_DEFAUT_MS = 180000;

// Rattrapage d'une recherche : on refait tourner la cartouche depuis le debut
// en jetant le son, par tranches de temps, pour ne pas figer la page.
const MS_RATTRAPAGE_PAR_APPEL = 20;
const SECONDES_RECHERCHE_MAX = 900;

// Part du temps d'un tampon audio qu'on s'autorise a passer dans le
// programme. Le rendu tourne sur le fil principal : une cartouche plus lourde
// que le temps reel (un effet calcule pixel par pixel en Fennel prend ~20 ms
// par image de 16,7 ms) gelerait toute la page. Au-dela du budget, on complete
// le tampon par du silence et la demo ralentit, comme sur une machine trop
// lente, sans rien bloquer.
const BUDGET_TAMPON = 0.6;

/**
 * Lecteur de cartouches TIC-80 (.tic), par le coeur de TIC-80 lui-meme (MIT,
 * nesbox) compile en WebAssembly.
 *
 * TIC-80 est une console imaginaire, comme PICO-8 : une cartouche est un
 * PROGRAMME (Lua, MoonScript, Fennel, JavaScript, Wren, Squirrel, Scheme,
 * Janet ou Python) qui dessine sur un ecran de 240 x 136 et pilote un
 * synthetiseur a quatre voix. C'est la plate-forme de la demoscene
 * « sizecoding » et des battles de live-coding.
 *
 * Le coeur synthetise a la cadence qu'on lui donne : on le cree a celle du
 * contexte audio, et chaque image (1/60 s) rend exactement son son, sans
 * reechantillonnage. Son horloge est virtuelle (voir shim.c) : time() d'une
 * demo suit le son rendu, pas la pendule.
 *
 * getScreen() rend l'image courante ; le visualiseur l'affiche a la place du
 * spectrogramme (voir components/Visualizer.js).
 */
export default class Tic80Player extends Player {
  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : charge au premier fichier.
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'tic80';
    this.name = 'TIC-80 Player';
    this.fileExtensions = fileExtensions;
    this.hasScreen = true;
    this.screenWidth = LARGEUR;
    this.screenHeight = HAUTEUR;
    this._ouvert = false;
    this._donnees = 0;        // la cartouche, dans le tas du wasm
    this._taille = 0;
    this._echantillons = 0;   // rendus, par canal
    this._dureeMs = DUREE_DEFAUT_MS;
    this._reste = 0;          // echantillons (par canal) restant dans l'image
    this._lu = 0;             // deja lus dans l'image courante
    this._ptr = 0;            // l'image courante dans le tas
    this._aRattraper = 0;     // images restant a traverser en silence
    this._image = null;       // Uint8ClampedArray LARGEUR x HAUTEUR RGBA
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../tic80');
    this.core = await mod.default();
    if (this.core._t8_create(this.sampleRate) !== 0) throw Error('tic-80 : coeur indisponible');
  }

  // Convention TIC-80 : les metadonnees sont des commentaires en tete du code,
  // « -- title: ... », « -- author: ... » (« // » en JS, « ;; » en Fennel...).
  // Le code est dans un bloc du .tic : on cherche les etiquettes dans tout le
  // fichier, il n'est pas compresse quand il est court.
  _metadonnees(data, filename) {
    const nom = (filename || '').split('/').pop().replace(/\.tic$/i, '');
    const texte = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 65536)));
    const tag = cle => {
      const m = new RegExp('(?:--|//|;;|#)\\s*' + cle + '\\s*:\\s*([^\\r\\n]*)', 'i').exec(texte);
      return m ? m[1].trim() : '';
    };
    return { title: tag('title') || nom, artist: tag('author'), langage: tag('script') };
  }

  _ouvrir() {
    const c = this.core;
    const r = c._t8_load(this._donnees, this._taille);
    if (r !== 0) {
      throw Error('tic-80 : ' + (c.UTF8ToString(c._t8_error()) || 'cartouche illisible'));
    }
    this._ouvert = true;
    this._reste = 0; this._lu = 0;
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    const c = this.core;

    // La cartouche reste dans le tas tant qu'elle est chargee : une recherche
    // la recharge.
    if (this._donnees) c._free(this._donnees);
    this._taille = data.length;
    this._donnees = c._malloc(data.length);
    c.HEAPU8.set(data, this._donnees);

    this._ouvrir();
    this._echantillons = 0;
    this._aRattraper = 0;
    this._dureeMs = DUREE_DEFAUT_MS;

    const { title, artist, langage } = this._metadonnees(data, filename);
    this.metadata = {
      title,
      artist,
      game: '',
      system: 'TIC-80',
      copyright: langage ? `${langage}` : '',
      play_length: this._dureeMs,
    };
    this.infoTexts = [];

    this.resolveParamValues(persistedSettings);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  // Une image : rend false si la cartouche s'est arretee (exit() ou erreur).
  _imageSuivante() {
    const c = this.core;
    let n;
    try {
      n = c._t8_tick();
    } catch (e) {
      // Une pile JS epuisee ou un abort du wasm : la cartouche s'arrete, avec
      // la raison, au lieu de laisser le lecteur dans un etat douteux.
      console.warn('tic-80 : arret sur exception', e);
      this._ouvert = false;
      return false;
    }
    if (n < 0) {
      console.warn('tic-80 :', n === -2 ? c.UTF8ToString(c._t8_error()) : 'la cartouche a appele exit()');
      return false;
    }
    this._ptr = c._t8_samples();
    this._reste = n >> 1;
    this._lu = 0;
    return true;
  }

  processAudioInner(channels) {
    if (this.paused || !this._ouvert) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    if (this._aRattraper > 0) {
      const limite = performance.now() + MS_RATTRAPAGE_PAR_APPEL;
      while (this._aRattraper > 0 && performance.now() < limite) {
        if (!this._imageSuivante()) { this._aRattraper = 0; break; }
        this._aRattraper--;
      }
      this._reste = 0;
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const attendus = channels[0].length;
    const limite = performance.now() + BUDGET_TAMPON * 1000 * attendus / this.sampleRate;
    let ecrits = 0;
    let fini = false;
    while (ecrits < attendus) {
      if (this._lu >= this._reste) {
        if (ecrits > 0 && performance.now() > limite) break;
        if (!this._imageSuivante()) { fini = true; break; }
        if (this._reste === 0) continue;
      }
      const tas = this.core.HEAP16;
      const base = (this._ptr >> 1) + this._lu * 2;
      const n = Math.min(attendus - ecrits, this._reste - this._lu);
      for (let ch = 0; ch < channels.length; ch++) {
        const sortie = channels[ch];
        const k = Math.min(ch, 1);
        for (let i = 0; i < n; i++) sortie[ecrits + i] = tas[base + i * 2 + k] / 32768;
      }
      this._lu += n;
      ecrits += n;
    }

    if (ecrits < attendus) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0, ecrits);
    }
    this._echantillons += ecrits;
    if (this._echantillons / this.sampleRate >= this._dureeMs / 1000) fini = true;
    if (fini) this.handleSongEnd();
  }

  /**
   * L'ecran courant, LARGEUR x HAUTEUR RGBA, ou null sans cartouche. Le tableau
   * rendu est reutilise d'un appel a l'autre : a copier si on veut le garder.
   */
  getScreen() {
    if (!this.core || !this._ouvert) return null;
    const p = this.core._t8_screen();
    if (!p) return null;
    const octets = LARGEUR * HAUTEUR * 4;
    if (!this._image) this._image = new Uint8ClampedArray(octets);
    this._image.set(this.core.HEAPU8.subarray(p, p + octets));
    // Le coeur laisse l'alpha a 0 : l'image serait transparente.
    for (let i = 3; i < octets; i += 4) this._image[i] = 255;
    return this._image;
  }

  getMetadata() { return this.metadata || {}; }

  getInfoTexts() { return this.infoTexts; }

  getDurationMs() { return this._dureeMs; }

  getPositionMs() { return (this._echantillons / this.sampleRate) * 1000; }

  // Recherche : on recharge la cartouche et l'on refait tourner le programme
  // jusqu'a l'instant vise, en jetant le son.
  seekMs(ms) {
    if (!this._ouvert || !this._donnees) return;
    const cible = Math.max(0, Math.min(ms, SECONDES_RECHERCHE_MAX * 1000));
    try { this._ouvrir(); } catch (e) { this._ouvert = false; return; }
    this._aRattraper = Math.round((cible / 1000) * 60);
    this._echantillons = Math.round((cible / 1000) * this.sampleRate);
  }

  getNumSubtunes() { return 1; }

  getSubtune() { return 0; }

  stop() {
    this.suspend();
    this._ouvert = false;
    this._echantillons = 0;
    this._aRattraper = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
