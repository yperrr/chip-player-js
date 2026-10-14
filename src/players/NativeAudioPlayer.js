import autoBind from 'auto-bind';
import Player from './Player';
import { readTags } from './native/tags';

// Playback of the compressed formats the browser already decodes.
//
// chip-core carries no stream decoder - no Vorbis, no MP3, no FLAC - yet a real
// collection holds a great many such files. The browser has decoded them
// forever, so this player hands them to a <audio> element and routes it into
// the existing audio graph.
//
// THREE WAYS IT DIFFERS FROM THE OTHER PLAYERS, all deliberate:
//
// 1. No wasm core. The constructor takes the audio context and the node to
//    feed instead, because that is what it actually needs.
//
// 2. It produces no samples. The others fill the buffers of the central
//    ScriptProcessor; this one is wired straight into the graph, so
//    processAudio() is overridden to do nothing at all. Leaving the base
//    implementation in place would be a bug: it watches the buffers it is
//    handed, would see nothing but silence, and would declare the song over.
//
// 3. Tags are read from the bytes already in hand. The Sequencer has fetched
//    the whole file by the time loadData runs, so no second request is needed.
//
// The element is created once and reused: createMediaElementSource() may only
// be called once per element.

const fileExtensions = [
  'ogg', 'oga', 'opus', 'mp3', 'flac', 'wav', 'm4a', 'aac', 'webm',
];

// Stands in for the "system" shown for an emulated tune.
const FORMAT_NAMES = {
  ogg: 'Ogg Vorbis', oga: 'Ogg Vorbis', opus: 'Opus', mp3: 'MP3',
  flac: 'FLAC', wav: 'WAV', m4a: 'AAC (MP4)', aac: 'AAC', webm: 'WebM',
};

const MIME_TYPES = {
  ogg: 'audio/ogg; codecs=vorbis', oga: 'audio/ogg; codecs=vorbis',
  opus: 'audio/ogg; codecs=opus', mp3: 'audio/mpeg', flac: 'audio/flac',
  wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm',
};

export default class NativeAudioPlayer extends Player {
  /**
   * @param {AudioContext} audioCtx
   * @param {AudioNode} destination node to feed, normally the master gain
   */
  constructor(audioCtx, destination, bufferSize = 2048, debug = false) {
    super(null, audioCtx.sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'native';
    this.name = 'Native Audio Player';
    this.audioCtx = audioCtx;
    this.destination = destination;
    this.tags = null;
    this.format = null;
    this.objectUrl = null;

    this.audioEl = document.createElement('audio');
    this.audioEl.preload = 'auto';
    this.audioEl.addEventListener('ended', () => this.handleSongEnd());

    // Only advertise what this browser will actually decode.
    this.fileExtensions = fileExtensions.filter(
      ext => !!this.audioEl.canPlayType(MIME_TYPES[ext]));

    this.sourceNode = audioCtx.createMediaElementSource(this.audioEl);
    this.sourceNode.connect(destination);
  }

  // The others render into the shared buffers; this one is already wired into
  // the graph. Doing nothing here is the whole point - see the header note.
  processAudio(channels) { /* audio flows through the media element */ }

  processAudioInner(channels) { /* never reached */ }

  async loadData(data, filepath) {
    const ext = filepath.slice(filepath.lastIndexOf('.') + 1).toLowerCase();
    this.format = FORMAT_NAMES[ext] || ext.toUpperCase();
    this.filepathMeta = Player.metadataFromFilepath(filepath);

    try {
      this.tags = readTags(data);
    } catch (e) {
      console.debug('NativeAudioPlayer: unreadable tags, falling back to the filename.', e);
      this.tags = null;
    }

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(new Blob([data], { type: MIME_TYPES[ext] || '' }));
    this.audioEl.src = this.objectUrl;

    // Wait for the duration, so the first state update carries a real one.
    await new Promise((resolve) => {
      const done = () => {
        this.audioEl.removeEventListener('loadedmetadata', done);
        this.audioEl.removeEventListener('error', done);
        resolve();
      };
      this.audioEl.addEventListener('loadedmetadata', done);
      this.audioEl.addEventListener('error', done);
    });

    this.stopped = false;
    this.paused = false;
    await this.audioEl.play().catch(e => {
      // Autoplay policies can refuse a sound that no gesture asked for. The
      // transport button will work, so this is not fatal.
      console.warn('NativeAudioPlayer: playback refused by the browser.', e.message);
    });
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  getMetadata() {
    // Same shape the emulated players return, so SongDetails needs no special
    // case: the artist joins the title line, album and format stand in for
    // game and system, and the year for the copyright.
    const t = this.tags || {};
    return {
      title: t.title || (this.filepathMeta && this.filepathMeta.title) || '',
      artist: t.artist || '',
      game: t.album || '',
      system: this.format || '',
      copyright: t.year || '',
    };
  }

  getDurationMs() {
    const d = this.audioEl.duration;
    return Number.isFinite(d) ? d * 1000 : 0;
  }

  getPositionMs() {
    return this.audioEl.currentTime * 1000;
  }

  seekMs(ms) {
    const d = this.audioEl.duration;
    if (Number.isFinite(d)) this.audioEl.currentTime = Math.min(d, Math.max(0, ms / 1000));
  }

  isPlaying() {
    return !this.isPaused();
  }

  suspend() {
    this.audioEl.pause();
    super.suspend();
  }

  resume() {
    super.resume();
    this.audioEl.play().catch(() => { /* refused: the button will do it */ });
  }

  stop() {
    this.suspend();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
