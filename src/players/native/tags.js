// Tag reading for the formats the browser decodes itself.
//
// ID3 and Vorbis comments both sit near the head of the file, so everything
// here works on the bytes the Sequencer has already fetched — no extra request.
//
// Three containers are covered, which is what the supported extensions need:
//   ID3v2.3/2.4  at the head of MP3 files
//   ID3v1        the 128 trailing bytes of older MP3 files
//   Vorbis       comments, found in FLAC metadata blocks and in the second
//                packet of Ogg Vorbis and Opus streams

const HEAD = 131072;   // tags live near the start; no need to scan whole files

function find(bytes, pattern, limit) {
  const end = Math.min(bytes.length, limit) - pattern.length;
  outer:
  for (let i = 0; i <= end; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

const decode = (bytes, label) =>
  new TextDecoder(label).decode(bytes).replace(/\0+$/, '').trim();

function id3Text(frame) {
  const body = frame.subarray(1);
  switch (frame[0]) {
    case 1: return decode(body, 'utf-16');      // byte-order mark leads
    case 2: return decode(body, 'utf-16be');
    case 3: return decode(body, 'utf-8');
    default: return decode(body, 'iso-8859-1');
  }
}

const ID3_KEYS = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TDRC: 'year', TYER: 'year' };

function readId3v2(b) {
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;   // "ID3"
  const version = b[3];
  if (version < 3) return null;   // 2.2 uses 6-byte frame headers; vanishingly rare
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const end = Math.min(10 + size, b.length);
  const out = {};
  let i = 10;
  while (i + 10 <= end) {
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;   // trailing padding
    // 2.4 counts in syncsafe integers (7 useful bits), 2.3 does not.
    const n = version >= 4
      ? ((b[i + 4] & 0x7f) << 21) | ((b[i + 5] & 0x7f) << 14) | ((b[i + 6] & 0x7f) << 7) | (b[i + 7] & 0x7f)
      : (b[i + 4] << 24) | (b[i + 5] << 16) | (b[i + 6] << 8) | b[i + 7];
    const start = i + 10;
    if (n <= 0 || start + n > b.length) break;
    if (ID3_KEYS[id]) out[ID3_KEYS[id]] = id3Text(b.subarray(start, start + n));
    i = start + n;
  }
  return Object.keys(out).length ? out : null;
}

// Many older files carry only the 128-byte trailer. It still beats a filename.
function readId3v1(b) {
  if (b.length < 128) return null;
  const t = b.subarray(b.length - 128);
  if (t[0] !== 0x54 || t[1] !== 0x41 || t[2] !== 0x47) return null;   // "TAG"
  const field = (from, to) => decode(t.subarray(from, to), 'iso-8859-1');
  const out = {};
  const title = field(3, 33), artist = field(33, 63);
  const album = field(63, 93), year = field(93, 97);
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (album) out.album = album;
  if (year) out.year = year;
  return Object.keys(out).length ? out : null;
}

const VORBIS_KEYS = { title: 'title', artist: 'artist', album: 'album', date: 'year' };

// FLAC stores Vorbis comments in a metadata block; Ogg and Opus put them in
// their second packet. The structure itself is identical.
function readVorbis(b) {
  let p = -1;
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) {   // "fLaC"
    let i = 4;
    while (i + 4 <= b.length) {
      const last = b[i] & 0x80, type = b[i] & 0x7f;
      const n = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
      if (type === 4) { p = i + 4; break; }
      if (last) break;
      i += 4 + n;
    }
  } else {
    p = find(b, [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], HEAD);         // 0x03 "vorbis"
    if (p >= 0) p += 7;
    else {
      const q = find(b, [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], HEAD);   // "OpusTags"
      if (q >= 0) p = q + 8;
    }
  }
  if (p < 0) return null;

  const u32 = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  let i = p;
  if (i + 4 > b.length) return null;
  i += 4 + u32(i);            // vendor string, of no interest here
  if (i + 4 > b.length) return null;
  let remaining = u32(i); i += 4;
  const out = {};
  // A long enough Ogg header spills into the next page, whose own header would
  // land in the middle of the fields: the bounds below stop the read there,
  // and whatever was already gathered is kept.
  while (remaining-- > 0 && i + 4 <= b.length) {
    const n = u32(i); i += 4;
    if (i + n > b.length) break;
    const s = decode(b.subarray(i, i + n), 'utf-8');
    i += n;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = VORBIS_KEYS[s.slice(0, eq).toLowerCase()];
    if (key && !out[key]) out[key] = s.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Read whatever tags the file carries.
 * @param {Uint8Array} bytes the whole file
 * @returns {{title?: string, artist?: string, album?: string, year?: string}|null}
 */
export function readTags(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, HEAD));
  return readId3v2(head) || readVorbis(head) || readId3v1(bytes);
}
