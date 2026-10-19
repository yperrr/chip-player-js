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
    this._reste = 0;         // echantillons restants dans le bloc decode
    this._prec = null;       // derniere trame du bloc precedent, indice -1
    this._termine = false;  // fin deja signalee ?
    this._pos = 0;           // position fractionnaire dans ce bloc
    this._bufPtr = 0;
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
    this._reste = 0; this._pos = 0; this._bufPtr = 0; this._prec = null;
    this._termine = false;

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
