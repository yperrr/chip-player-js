// DOOM MUS to standard MIDI.
//
// MUS is id Software's music format (DOOM, Heretic, Hexen, Raptor). It is
// compacted MIDI: the same events, encoded shorter, on a fixed 140 Hz tick.
// No wasm engine decodes it, but the project already embeds fluidsynth, so
// restoring the standard MIDI shape is enough to play it.
//
// Beware the extension clash: SIDPlayer also claims 'mus', for Compute!'s
// Sidplayer format on the C64, which is unrelated. Decide on the header
// (`MUS\x1a`), never on the file name — see isMus() below.

const HEADER = [0x4d, 0x55, 0x53, 0x1a];   // "MUS" then 0x1a

/** True when the bytes really are a DOOM MUS file. */
export function isMus(bytes) {
  return bytes.length > 16 && HEADER.every((v, i) => bytes[i] === v);
}

// The fourteen MUS controllers, in order, mapped to their MIDI numbers.
// Index 0 is not a controller but a program change, handled separately.
const CONTROLLERS = [
  0,    // 0  instrument (program change)
  0,    // 1  bank select
  1,    // 2  modulation
  7,    // 3  volume
  10,   // 4  pan
  11,   // 5  expression
  91,   // 6  reverb depth
  93,   // 7  chorus depth
  64,   // 8  sustain pedal
  67,   // 9  soft pedal
  120,  // 10 all sounds off
  123,  // 11 all notes off
  126,  // 12 mono mode
  127,  // 13 poly mode
  121,  // 14 reset all controllers
];

// MUS reserves its channel 15 for percussion, MIDI its channel 9: the two
// swap, everything else passes through.
const toMidiChannel = c => (c === 15 ? 9 : c === 9 ? 15 : c);

/**
 * Convert a DOOM MUS file to a standard MIDI file (format 0).
 * @param {Uint8Array} mus
 * @returns {Uint8Array} the MIDI file bytes
 */
export function musToMidi(mus) {
  if (!isMus(mus)) throw new Error('Not a DOOM MUS file.');

  const u16 = o => mus[o] | (mus[o + 1] << 8);
  const scoreLength = u16(4);
  const scoreStart = u16(6);
  if (scoreStart >= mus.length) throw new Error('MUS: score starts past end of file.');

  const track = [];
  const volume = new Array(16).fill(127);   // per-channel running volume
  let pending = 0;                          // ticks accumulated before next event

  // Variable-length quantity: seven useful bits per byte, high bit means
  // "more follows". This is MIDI's delta-time encoding and also MUS's delay
  // encoding, so delays carry over unchanged.
  function writeDelta(n) {
    const stack = [n & 0x7f];
    n >>= 7;
    while (n > 0) { stack.unshift((n & 0x7f) | 0x80); n >>= 7; }
    track.push(...stack);
  }

  function emit(...bytes) {
    writeDelta(pending);
    pending = 0;
    track.push(...bytes);
  }

  let i = scoreStart;
  const end = Math.min(scoreStart + scoreLength, mus.length);

  while (i < end) {
    const descriptor = mus[i++];
    const type = (descriptor >> 4) & 7;
    const channel = descriptor & 15;
    const delayFollows = descriptor & 0x80;
    const mc = toMidiChannel(channel);

    if (type === 0) {                          // release note
      emit(0x80 | mc, mus[i++] & 0x7f, 0);
    } else if (type === 1) {                   // play note
      let note = mus[i++];
      // Volume only accompanies the note when the high bit is set; otherwise
      // the channel's last volume applies.
      if (note & 0x80) { note &= 0x7f; volume[channel] = mus[i++] & 0x7f; }
      emit(0x90 | mc, note, volume[channel]);
    } else if (type === 2) {                   // pitch wheel
      // One byte in MUS, fourteen bits in MIDI: the factor 64 puts value 128
      // exactly at centre (8192).
      const v = mus[i++] * 64;
      emit(0xe0 | mc, v & 0x7f, (v >> 7) & 0x7f);
    } else if (type === 3) {                   // system event
      const n = mus[i++] & 0x7f;
      emit(0xb0 | mc, CONTROLLERS[n] || 0, 0);
    } else if (type === 4) {                   // change controller
      const n = mus[i++] & 0x7f;
      const v = mus[i++] & 0x7f;
      if (n === 0) emit(0xc0 | mc, v);         // program change
      else emit(0xb0 | mc, CONTROLLERS[n] || 0, v);
    } else if (type === 5) {                   // end of measure, no payload
      /* nothing */
    } else if (type === 6) {                   // score end
      break;
    } else {                                   // type 7, unused
      i++;
    }

    if (delayFollows) {
      let d = 0, o;
      do { o = mus[i++]; d = (d << 7) | (o & 0x7f); } while (o & 0x80 && i < end);
      pending += d;
    }
  }

  writeDelta(pending);
  track.push(0xff, 0x2f, 0x00);                // end of track

  // Division of 70 ticks per quarter note. With no tempo event, MIDI runs at
  // 120 BPM, i.e. 140 ticks per second — exactly the MUS rate. Delays are
  // therefore copied across with no arithmetic at all.
  const n = track.length;
  const out = new Uint8Array(22 + n);
  out.set([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,        // "MThd", length 6
    0, 0,                                       // format 0
    0, 1,                                       // one track
    0, 70,                                      // division
    0x4d, 0x54, 0x72, 0x6b,                     // "MTrk"
    (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255,
  ]);
  out.set(track, 22);
  return out;
}
