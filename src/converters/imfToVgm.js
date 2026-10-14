// id Software IMF to VGM.
//
// IMF (id Music Format) is the AdLib music of Wolfenstein 3D, Commander Keen,
// Blake Stone, Bio Menace. It is not a score but a LOG of register writes
// aimed at the OPL2 (YM3812): four bytes per entry — register, value, then a
// two-byte delay.
//
// VGM, which the project already plays through libvgm, is of the very same
// nature: a stream of register writes interleaved with waits. The conversion
// is therefore not emulation but a change of wrapper. And the chip is present:
// YM3812, YM3526, YMF262 and Y8950 all appear in chip-core.
//
// IMF has NO magic number — it is a raw stream. Unlike DOOM's MUS, the content
// cannot arbitrate, so this relies on the file extension, which is safe here
// because no other engine claims it.

const SAMPLE_RATE = 44100;       // VGM's fixed rate
const OPL2_CLOCK = 3579545;      // YM3812, the usual crystal

/**
 * Convert an id Software IMF log to a VGM 1.51 file.
 * @param {Uint8Array} imf
 * @returns {Uint8Array} the VGM file bytes
 */
export function imfToVgm(imf) {
  let i = 0;
  let end = imf.length;

  // Type 1 carries the data length in its first two bytes. The test rests on
  // an entry being four bytes long: a length that is not a multiple of four,
  // or that overflows the file, is not one. A type 0 file starts straight away
  // with a write and rarely meets all three conditions at once.
  const word = imf[0] | (imf[1] << 8);
  const type1 = word > 0 && word % 4 === 0 && word <= imf.length - 2;
  if (type1) { i = 2; end = Math.min(2 + word, imf.length); }

  // The rate is not stored in the file, it depends on the game. The two
  // families are told apart by the file's shape: those whose header announces
  // the data length (Wolfenstein 3D and relatives) run at 700 Hz, the others
  // (Commander Keen and company) at 560 Hz. This is the convention used by
  // players of the genre.
  const rate = type1 ? 700 : 560;

  const data = [];
  let ticks = 0;       // elapsed time, in the file's own unit
  let position = 0;    // the same, converted to samples

  while (i + 4 <= end) {
    const register = imf[i];
    const value = imf[i + 1];
    const delay = imf[i + 2] | (imf[i + 3] << 8);
    i += 4;

    data.push(0x5a, register, value);          // YM3812 write

    if (!delay) continue;
    // Convert the absolute position rather than each delay in isolation:
    // rounding thousands of small delays separately would drift the tune by
    // several seconds over its length.
    ticks += delay;
    const target = Math.round((ticks * SAMPLE_RATE) / rate);
    let remaining = target - position;
    position = target;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 0xffff);
      data.push(0x61, chunk & 0xff, (chunk >> 8) & 0xff);   // wait
      remaining -= chunk;
    }
  }
  data.push(0x66);   // end of sound data

  // 0x80-byte header, version 1.51. No loop point: the tune plays once and
  // hands back, which lets the folder advance normally. The player's own
  // repeat remains available for anyone wanting the game's loop.
  const size = 0x80 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const u32 = (o, v) => view.setUint32(o, v, true);

  out.set([0x56, 0x67, 0x6d, 0x20]);   // "Vgm "
  u32(0x04, size - 4);                  // end of file, relative to 0x04
  u32(0x08, 0x00000151);                // version 1.51
  u32(0x18, position);                  // total number of samples
  u32(0x34, 0x80 - 0x34);               // data offset, relative to 0x34
  u32(0x50, OPL2_CLOCK);                // YM3812 clock
  out.set(data, 0x80);
  return out;
}
