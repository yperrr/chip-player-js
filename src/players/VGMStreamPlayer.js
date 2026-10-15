import Player from './Player.js';
import autoBind from 'auto-bind';
import EXTENSIONS_VGMSTREAM from '../vgmstream-extensions.json';

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
const fileExtensions = EXTENSIONS_VGMSTREAM;

const SFMT_PCM16 = 1;
const SFMT_FLOAT = 4;

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
    this.buf = 0;
    this.cheminFs = null;
    this._subtune = 0;
    this._nbSubtunes = 1;
    this._dureeMs = 0;
    this.infoTexts = [];
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../vgmstream');
    this.core = await mod.default();
    // float stereo entrelace : channels * 4 octets * bufferSize
    this.buf = this.core._malloc(this.bufferSize * 4 * 8);
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

    // vgmstream lit par un « streamfile » et reconnait beaucoup de formats a
    // l'extension : on ecrit donc le fichier dans le systeme de fichiers
    // d'emscripten sous son vrai nom, et on le lui ouvre par chemin. Cela evite
    // d'exposer des pointeurs de fonction au JavaScript pour l'interface d'E/S.
    const nom = filename.split('/').pop();
    this.cheminFs = '/tmp/' + nom;
    try { this.core.FS.mkdir('/tmp'); } catch (e) { /* existe deja */ }
    this.core.FS.writeFile(this.cheminFs, data);

    const cheminPtr = this.core._malloc(this.cheminFs.length + 1);
    this.core.stringToUTF8(this.cheminFs, cheminPtr, this.cheminFs.length + 1);
    const libsf = this.core._libstreamfile_open_from_stdio(cheminPtr);
    this.core._free(cheminPtr);
    if (!libsf) {
      this._nettoyer();
      throw Error('vgmstream: streamfile non ouvert');
    }

    // Aucune configuration passee : les valeurs par defaut conviennent (une
    // boucle, fondu standard), et surtout cela evite de dependre des decalages
    // de libvgmstream_config_t, que rien ne verifierait. On lit le format de
    // sortie plutot que de l'imposer.
    this.lib = this.core._libvgmstream_create(libsf, this._subtune + 1, 0);
    this.core._libstreamfile_close(libsf);

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
    this.resolveParamValues(persistedSettings);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
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
    this._reste = 0; this._lu = 0; this._bufPtr = 0;

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
   * Le decodeur ne rend pas forcement bufferSize echantillons d'un coup (1024
   * en pratique) : on conserve donc le reliquat d'un appel au suivant.
   */
  processAudioInner(channels) {
    if (this.paused || !this.lib) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const c = this.core;
    const nCanaux = this._canaux || 1;
    const attendus = channels[0].length;
    let ecrits = 0;
    let fini = false;

    while (ecrits < attendus) {
      if (this._reste <= 0) {
        if (c._libvgmstream_render(this.lib) < 0) { fini = true; break; }
        const dec = c.getValue(this.lib + LIB_DECODER_PTR, '*');
        this._bufPtr = c.getValue(dec + DEC_BUF, '*');
        this._reste = c.getValue(dec + DEC_BUF_SAMPLES, 'i32');
        this._lu = 0;
        if (c.getValue(dec + DEC_DONE, 'i8')) fini = true;
        if (this._reste <= 0) break;
      }
      const n = Math.min(this._reste, attendus - ecrits);
      for (let ch = 0; ch < channels.length; ch++) {
        // Un flux mono alimente les deux sorties ; au-dela de deux canaux on
        // ne garde que les premiers, faute de meilleure reduction.
        const src = Math.min(ch, nCanaux - 1);
        const sortie = channels[ch];
        for (let i = 0; i < n; i++) {
          const idx = (this._lu + i) * nCanaux + src;
          sortie[ecrits + i] = this._estFloat
            ? c.HEAPF32[(this._bufPtr >> 2) + idx]
            : c.HEAP16[(this._bufPtr >> 1) + idx] / 32768;
        }
      }
      this._lu += n;
      this._reste -= n;
      ecrits += n;
    }

    if (ecrits < attendus) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0, ecrits);
    }
    if (fini && ecrits === 0) this.handleSongEnd();
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
    this.core._libvgmstream_seek(this.lib, ech);
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
    this._subtune = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
