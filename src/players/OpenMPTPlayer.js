import Player from './Player.js';
import autoBind from 'auto-bind';
import EXTENSIONS_LIBOPENMPT from '../libopenmpt-extensions.json';

// Extensions que libopenmpt sait lire mais qu'on ne lui confie PAS, parce
// qu'un autre moteur les revendique pour un format homonyme et sans rapport :
//
//   mus  - ici « Doom Music », chez nous le MUS de DOOM (converti en MIDI par
//          MIDIPlayer) et celui du C64 (SIDPlayer). Trois formats, un seul nom.
//   imf  - ici « Imago Orpheus », chez nous le journal de registres OPL2 de
//          Wolfenstein 3D, rehabille en VGM par VGMPlayer.
//
// Sans cette mise a l'ecart, libopenmpt passant AVANT ces moteurs leur volerait
// l'extension et echouerait a l'ouverture — silencieusement du point de vue de
// l'utilisateur, qui verrait juste un fichier refuse.
const RESERVEES_AILLEURS = new Set(['mus', 'imf']);

// La liste vient de la bibliotheque elle-meme : elle est produite a la
// construction du wasm par scripts/emscripten/libopenmpt/, en appelant
// openmpt_get_supported_extensions() sur le binaire qu'on embarque. Elle ne
// peut donc pas deriver de ce que le moteur sait reellement lire — c'est
// exactement la derive qu'avait connue la liste de GME, bridee a cinq
// extensions alors que libgme en decodait davantage.
const fileExtensions = EXTENSIONS_LIBOPENMPT.filter(e => !RESERVEES_AILLEURS.has(e));

// openmpt_module_render_param, voir libopenmpt.h
const RENDER_MASTERGAIN_MILLIBEL = 1;
const RENDER_STEREOSEPARATION_PERCENT = 2;
const RENDER_INTERPOLATIONFILTER_LENGTH = 3;

export default class OpenMPTPlayer extends Player {
  paramDefs = [
    {
      id: 'interpolation',
      label: 'Interpolation',
      type: 'enum',
      options: [{
        label: 'Interpolation Mode',
        items: [
          { label: 'Nearest-neighbor (None)', value: 1 },
          { label: 'Linear', value: 2 },
          { label: 'Cubic', value: 4 },
          { label: 'Sinc (8 taps)', value: 8 },
        ],
      }],
      defaultValue: 8,
    },
    {
      id: 'stereoSeparation',
      label: 'Stereo Separation',
      type: 'number',
      min: 0,
      max: 200,
      step: 5,
      defaultValue: 100,
    },
  ];

  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : il est charge au premier fichier.
    // Voir loadData().
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'openmpt';
    this.name = 'OpenMPT Player';
    this.fileExtensions = fileExtensions;
    this.module = 0;          // openmpt_module*
    this.bufGauche = 0;
    this.bufDroite = 0;
    this._tempo = 1;
    this.infoTexts = [];
  }

  /**
   * Charge le moteur au premier usage.
   *
   * Le wasm pese ~1,2 Mo. Le construire au demarrage le mettrait sur le chemin
   * critique de toutes les pages, y compris celles qui ne joueront jamais un
   * module. C'est la meme raison qui fait importer chip-core paresseusement
   * dans src/components/App.js.
   */
  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../libopenmpt');
    this.core = await mod.default();
    this.bufGauche = this.core._malloc(this.bufferSize * 4);   // f32
    this.bufDroite = this.core._malloc(this.bufferSize * 4);
  }

  _chaine(ptr) {
    if (!ptr) return '';
    const s = this.core.UTF8ToString(ptr);
    this.core._openmpt_free_string(ptr);
    return s;
  }

  _meta(cle) {
    const clePtr = this.core._malloc(cle.length + 1);
    this.core.stringToUTF8(cle, clePtr, cle.length + 1);
    const valeur = this._chaine(this.core._openmpt_module_get_metadata(this.module, clePtr));
    this.core._free(clePtr);
    return valeur;
  }

  _libererModule() {
    if (this.module) {
      this.core._openmpt_module_destroy(this.module);
      this.module = 0;
    }
  }

  processAudioInner(channels) {
    if (this.paused || !this.module) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const rendus = this.core._openmpt_module_read_float_stereo(
      this.module, this.sampleRate, this.bufferSize, this.bufGauche, this.bufDroite);

    if (rendus === 0) {
      // Fin du morceau. Le tampon n'a rien recu : le mettre a zero avant de
      // rendre la main, sinon il rejouerait le contenu precedent.
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      this.handleSongEnd();
      return;
    }

    // Lecture par vue typee plutot que getValue() echantillon par echantillon :
    // c'est le meme tas, mais sans un appel de fonction par valeur.
    const gauche = this.core.HEAPF32.subarray(this.bufGauche >> 2, (this.bufGauche >> 2) + rendus);
    const droite = this.core.HEAPF32.subarray(this.bufDroite >> 2, (this.bufDroite >> 2) + rendus);
    for (let ch = 0; ch < channels.length; ch++) {
      const source = ch === 0 ? gauche : droite;
      channels[ch].set(source);
      // Dernier tampon d'un morceau : libopenmpt peut en rendre moins que demande.
      if (rendus < channels[ch].length) channels[ch].fill(0, rendus);
    }
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    this._libererModule();

    const dataPtr = this.copyToHeap(data);
    // Les trois derniers arguments sont les rappels de journalisation et
    // d'erreur, et les controles initiaux : rien a passer.
    this.module = this.core._openmpt_module_create_from_memory2(
      dataPtr, data.length, 0, 0, 0, 0, 0, 0, 0);
    this.core._free(dataPtr);

    if (!this.module) {
      throw Error('openmpt_module_create_from_memory2 failed');
    }

    // Boucler indefiniment n'est pas souhaitable : c'est le sequenceur qui
    // decide d'enchainer ou de repeter.
    this.core._openmpt_module_set_repeat_count(this.module, 0);

    this._lireMetadonnees();
    this.resolveParamValues(persistedSettings);
    this.setTempo(persistedSettings.tempo || 1);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  _lireMetadonnees() {
    const meta = {};
    meta.title = this._meta('title') || this.filepathMeta.title;
    meta.artist = this._meta('artist');
    meta.system = this._meta('type_long') || this.filepathMeta.system;
    meta.numChannels = this.core._openmpt_module_get_num_channels(this.module);
    meta.numPatterns = this.core._openmpt_module_get_num_patterns(this.module);
    meta.numInstruments = this.core._openmpt_module_get_num_instruments(this.module);
    meta.numSamples = this.core._openmpt_module_get_num_samples(this.module);

    const textes = [];
    const message = this._meta('message_raw');
    if (message && message.trim()) textes.push('Comment:', message);
    const tracker = this._meta('tracker');
    if (tracker) meta.tracker = tracker;

    this.metadata = meta;
    this.infoTexts = textes.length ? [textes.join('\n\n')] : [];
  }

  getMetadata() {
    return this.metadata || {};
  }

  getInfoTexts() {
    return this.infoTexts;
  }

  getDurationMs() {
    if (!this.module) return 0;
    return this.core._openmpt_module_get_duration_seconds(this.module) * 1000;
  }

  getPositionMs() {
    if (!this.module) return 0;
    return this.core._openmpt_module_get_position_seconds(this.module) * 1000;
  }

  seekMs(ms) {
    if (!this.module) return;
    this.core._openmpt_module_set_position_seconds(this.module, ms / 1000);
  }

  getNumSubtunes() {
    if (!this.module) return 1;
    return this.core._openmpt_module_get_num_subsongs(this.module);
  }

  getSubtune() {
    if (!this.module) return 0;
    return this.core._openmpt_module_get_selected_subsong(this.module);
  }

  playSubtune(subtune) {
    if (!this.module) return;
    this.core._openmpt_module_select_subsong(this.module, subtune);
    this.core._openmpt_module_set_position_seconds(this.module, 0);
    this._lireMetadonnees();
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  getTempo() {
    return this._tempo;
  }

  setTempo(val) {
    this._tempo = val;
    if (!this.module) return;
    // La vitesse n'est pas un parametre de rendu chez libopenmpt mais un
    // « controle », play.tempo_factor.
    //
    // Et il faut le poser par ctl_set_floatingpoint : ctl_set_text rend 1,
    // c'est-a-dire succes, sans rien appliquer — releve en mesurant l'effet,
    // la valeur relue restant obstinement a 1 pendant que l'appel se disait
    // satisfait.
    const cle = 'play.tempo_factor';
    const clePtr = this.core._malloc(cle.length + 1);
    this.core.stringToUTF8(cle, clePtr, cle.length + 1);
    this.core._openmpt_module_ctl_set_floatingpoint(this.module, clePtr, val);
    this.core._free(clePtr);
  }

  setParameter(id, value) {
    super.setParameter(id, value);
    if (!this.module) return;
    if (id === 'interpolation') {
      this.core._openmpt_module_set_render_param(
        this.module, RENDER_INTERPOLATIONFILTER_LENGTH, parseInt(value, 10));
    } else if (id === 'stereoSeparation') {
      this.core._openmpt_module_set_render_param(
        this.module, RENDER_STEREOSEPARATION_PERCENT, parseInt(value, 10));
    } else if (id === 'masterGain') {
      this.core._openmpt_module_set_render_param(
        this.module, RENDER_MASTERGAIN_MILLIBEL, parseInt(value, 10));
    }
  }

  isPlaying() {
    return !this.isPaused() && !this.stopped;
  }

  stop() {
    this.suspend();
    this._libererModule();
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
