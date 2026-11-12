// Duree d'un morceau, mesuree a l'indexation, pour TOUS les moteurs qui le
// permettent — et pas seulement vgmstream.
//
// A QUOI CELA SERT
//
// A l'alignement de l'administration : renommer un dossier aux noms opaques
// en comparant ses fichiers a une tracklist, ou en aidant AcoustID, qui
// compare aussi les durees. Sans duree au catalogue, ni l'un ni l'autre n'ont
// de prise. Jusqu'ici, seul vgmstream mesurait ; un .psf, un .vgm, un .mid ou
// un .mod restaient sans duree.
//
// LA REGLE : LA DUREE QUE LE LECTEUR JOUE
//
// Chaque mesure reproduit ce que le moteur du lecteur annonce, pas une valeur
// « ideale » : un .vgm qui boucle dure intro + deux boucles + un fondu de 4 s,
// comme dans libvgm ; un .psf dure length + fade, comme dans PSFPlayer. Et la
// BOUCLE, quand le format la declare, est rendue a part : c'est elle qui
// permet a l'alignement de comparer « intro + une boucle » a un album.
//
// CE QUE RENDENT LES MESURES
//
//   { ms, boucle: { debutMs, finMs } | null }   ms = 0 : tente, sans resultat
//   null                                       le moteur n'a pas pu etre
//                                              interroge (wasm absent) : a
//                                              reprendre plus tard
//   undefined                                  aucune mesure pour ce format
//
// Tout est lu dans l'EN-TETE ou les metadonnees, sans rien decoder, sauf les
// modules tracker : leur duree n'est ecrite nulle part, libopenmpt la calcule
// en parcourant la partition — sans produire de son, en quelques
// millisecondes.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vgmstream = require('./duration-vgmstream');

const rien = { ms: 0, boucle: null };
const avec = (ms, boucle = null) => ({ ms: ms > 0 && ms < 24 * 3600 * 1000 ? Math.round(ms) : 0, boucle });

// --- Famille xSF : etiquettes length et fade -----------------------------------

const EXT_XSF = new Set(['psf', 'minipsf', 'psf2', 'minipsf2', 'ssf', 'minissf', 'dsf', 'minidsf',
  'gsf', 'minigsf', '2sf', 'mini2sf', 'ncsf', 'minincsf', 'usf', 'miniusf', 'snsf', 'minisnsf', 'qsf', 'miniqsf']);

function dureeTag(v) {
  if (v === undefined || v === null) return 0;
  const parties = String(v).trim().replace(',', '.').split(':');
  if (parties.length > 3) return 0;
  let s = 0;
  for (const p of parties) {
    if (!/^\d+(\.\d+)?$/.test(p.trim())) return 0;
    s = s * 60 + parseFloat(p);
  }
  return s * 1000;
}

function xsf(b) {
  if (b.length < 16 || b.toString('latin1', 0, 3) !== 'PSF') return rien;
  const debut = 16 + b.readUInt32LE(4) + b.readUInt32LE(8);
  if (debut + 5 > b.length || b.toString('latin1', debut, debut + 5) !== '[TAG]') return rien;
  const t = {};
  for (const ligne of b.toString('latin1', debut + 5).split('\n')) {
    const i = ligne.indexOf('=');
    if (i > 0) t[ligne.slice(0, i).trim().toLowerCase()] = ligne.slice(i + 1).trim();
  }
  // Comme PSFPlayer : length + fade. Sans length, le lecteur joue 2:30 par
  // defaut — une duree de convention, qu'on n'inscrit pas.
  const longueur = dureeTag(t.length);
  return longueur ? avec(longueur + dureeTag(t.fade)) : rien;
}

// --- VGM / VGZ : en-tete -------------------------------------------------------

function vgm(b) {
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try { b = zlib.gunzipSync(b); } catch (e) { return rien; }
  }
  if (b.length < 0x24 || b.toString('latin1', 0, 4) !== 'Vgm ') return rien;
  const total = b.readUInt32LE(0x18);
  const decalageBoucle = b.readUInt32LE(0x1c);
  const echBoucle = b.readUInt32LE(0x20);
  if (!total) return rien;
  // libvgm (src/bindings/libvgm-wrapper.cpp) : deux passages de la boucle,
  // puis un fondu de 4 s quand le morceau boucle.
  if (decalageBoucle && echBoucle > 0 && echBoucle <= total) {
    const ms = ((total + echBoucle) / 44100) * 1000 + 4000;
    return avec(ms, { debutMs: Math.round(((total - echBoucle) / 44100) * 1000), finMs: Math.round((total / 44100) * 1000) });
  }
  return avec((total / 44100) * 1000);
}

// --- MIDI standard : parcours de la partition, carte des tempos ------------------

function midi(b) {
  if (b.length < 14 || b.toString('latin1', 0, 4) !== 'MThd') return rien;
  const division = b.readUInt16BE(12);
  const tempos = [];   // [tick, microsecondes par noire]
  let finTick = 0;
  let p = 8 + b.readUInt32BE(4);
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4);
    const longueur = b.readUInt32BE(p + 4);
    const debut = p + 8;
    const fin = Math.min(b.length, debut + longueur);
    p = debut + longueur;
    if (type !== 'MTrk') continue;
    let i = debut;
    let tick = 0;
    let statut = 0;
    const vlq = () => {
      let v = 0;
      for (let k = 0; k < 4 && i < fin; k++) {
        const o = b[i++];
        v = (v << 7) | (o & 0x7f);
        if (!(o & 0x80)) break;
      }
      return v;
    };
    while (i < fin) {
      tick += vlq();
      if (i >= fin) break;
      let o = b[i];
      if (o & 0x80) { statut = o; i++; } else if (!statut) break;
      if (statut === 0xff) {
        const meta = b[i++];
        const n = vlq();
        if (meta === 0x51 && n === 3 && i + 3 <= fin) tempos.push([tick, (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]]);
        i += n;
        if (meta === 0x2f) break;
        statut = 0;
      } else if (statut === 0xf0 || statut === 0xf7) {
        i += vlq();
        statut = 0;
      } else {
        const h = statut & 0xf0;
        i += (h === 0xc0 || h === 0xd0) ? 1 : 2;
      }
    }
    finTick = Math.max(finTick, tick);
  }
  if (!finTick) return rien;
  if (division & 0x8000) {
    // SMPTE : images par seconde et ticks par image.
    const ips = 256 - (division >> 8);
    const tpi = division & 0xff;
    return ips && tpi ? avec((finTick / (ips * tpi)) * 1000) : rien;
  }
  if (!division) return rien;
  tempos.sort((a, c) => a[0] - c[0]);
  let ms = 0;
  let dernier = 0;
  let tempo = 500000;
  for (const [t, v] of tempos) {
    if (t > finTick) break;
    ms += ((t - dernier) * tempo) / division / 1000;
    dernier = t;
    tempo = v;
  }
  ms += ((finTick - dernier) * tempo) / division / 1000;
  return avec(ms);
}

// --- Audio ordinaire : WAV, FLAC, Ogg, MP3 -----------------------------------------

function wav(b) {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return rien;
  let p = 12;
  let octetsParSeconde = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const n = b.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 16 <= b.length) octetsParSeconde = b.readUInt32LE(p + 16);
    if (id === 'data') {
      const taille = Math.min(n, b.length - p - 8);
      return octetsParSeconde ? avec((taille / octetsParSeconde) * 1000) : rien;
    }
    p += 8 + n + (n & 1);
  }
  return rien;
}

function flac(b) {
  let p = 0;
  if (b.toString('latin1', 0, 3) === 'ID3' && b.length > 10) {
    p = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  }
  if (b.toString('latin1', p, p + 4) !== 'fLaC' || p + 8 + 18 > b.length) return rien;
  const s = p + 8;   // bloc STREAMINFO
  const taux = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
  const total = (b[s + 13] & 0x0f) * 4294967296 + b.readUInt32BE(s + 14);
  return taux && total ? avec((total / taux) * 1000) : rien;
}

function ogg(b) {
  // Le taux et le pre-saut dans le premier paquet, la position dans la
  // derniere page.
  let taux = 0;
  let preSaut = 0;
  const vorbis = b.indexOf('\x01vorbis', 0, 'latin1');
  const opus = b.indexOf('OpusHead', 0, 'latin1');
  if (vorbis >= 0 && vorbis < 512 && vorbis + 16 <= b.length) taux = b.readUInt32LE(vorbis + 12);
  else if (opus >= 0 && opus < 512 && opus + 12 <= b.length) { taux = 48000; preSaut = b.readUInt16LE(opus + 10); }
  if (!taux) return rien;
  for (let i = b.length - 14; i >= 0; i--) {
    if (b[i] === 0x4f && b.toString('latin1', i, i + 4) === 'OggS') {
      const pos = b.readUInt32LE(i + 6) + b.readUInt32LE(i + 10) * 4294967296;
      return pos > 0 && pos < 2 ** 52 ? avec(((pos - preSaut) / taux) * 1000) : rien;
    }
  }
  return rien;
}

const MP3_DEBITS = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // MPEG-1 couche III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // MPEG-2/2.5 couche III
};
const MP3_TAUX = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3(b) {
  let p = 0;
  if (b.toString('latin1', 0, 3) === 'ID3' && b.length > 10) {
    p = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  }
  // Premiere trame valide.
  for (const limite = Math.min(b.length - 4, p + 65536); p < limite; p++) {
    if (b[p] === 0xff && (b[p + 1] & 0xe0) === 0xe0) {
      const version = (b[p + 1] >> 3) & 3;
      const couche = (b[p + 1] >> 1) & 3;
      const iDebit = b[p + 2] >> 4;
      const iTaux = (b[p + 2] >> 2) & 3;
      if (version !== 1 && couche === 1 && iDebit > 0 && iDebit < 15 && iTaux < 3) break;
    }
  }
  if (p + 4 > b.length) return rien;
  const version = (b[p + 1] >> 3) & 3;
  const mpeg1 = version === 3;
  const taux = MP3_TAUX[version] && MP3_TAUX[version][(b[p + 2] >> 2) & 3];
  const debit = MP3_DEBITS[mpeg1 ? 1 : 2][b[p + 2] >> 4] * 1000;
  if (!taux || !debit) return rien;
  const echParTrame = mpeg1 ? 1152 : 576;
  const mono = (b[p + 3] >> 6) === 3;
  // En-tete Xing / Info (debit variable) : le nombre de trames y est ecrit.
  const xing = p + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const marque = b.toString('latin1', xing, xing + 4);
  if ((marque === 'Xing' || marque === 'Info') && (b.readUInt32BE(xing + 4) & 1)) {
    return avec((b.readUInt32BE(xing + 8) * echParTrame / taux) * 1000);
  }
  const vbri = p + 36;
  if (b.toString('latin1', vbri, vbri + 4) === 'VBRI') {
    return avec((b.readUInt32BE(vbri + 14) * echParTrame / taux) * 1000);
  }
  // Debit constant : la taille suffit (moins une etiquette ID3v1 finale).
  const fin = b.length - (b.toString('latin1', b.length - 128, b.length - 125) === 'TAG' ? 128 : 0);
  return avec(((fin - p) * 8 / debit) * 1000);
}

// --- Modules tracker : libopenmpt ----------------------------------------------------

let openmpt = null;
let openmptIndisponible = false;
const EXT_OPENMPT = (() => {
  try { return new Set(require('../src/libopenmpt-extensions.json')); } catch (e) { return new Set(); }
})();

async function initialiserOpenmpt() {
  if (openmpt || openmptIndisponible || !EXT_OPENMPT.size) return;
  try {
    const dossier = vgmstream.DOSSIER_MOTEURS;
    const mod = await import('file://' + path.join(dossier, 'libopenmpt.js').replace(/\\/g, '/'));
    openmpt = await mod.default({ wasmBinary: fs.readFileSync(path.join(dossier, 'libopenmpt.wasm')) });
  } catch (e) {
    openmptIndisponible = true;
    console.warn('durees : libopenmpt indisponible (%s) — les modules tracker resteront sans duree.', e.message);
  }
}

function tracker(b) {
  if (!openmpt) return null;
  if (b.length > 64 * 1024 * 1024) return rien;
  let ptr = 0;
  let module = 0;
  try {
    ptr = openmpt._malloc(b.length);
    openmpt.HEAPU8.set(b, ptr);
    module = openmpt._openmpt_module_create_from_memory2(ptr, b.length, 0, 0, 0, 0, 0, 0, 0);
    if (!module) return rien;
    return avec(openmpt._openmpt_module_get_duration_seconds(module) * 1000);
  } catch (e) {
    return rien;
  } finally {
    if (module) openmpt._openmpt_module_destroy(module);
    if (ptr) openmpt._free(ptr);
  }
}

// --- Aiguillage -------------------------------------------------------------------

// Par extension, dans l'ordre d'arbitrage du lecteur (src/components/App.js) :
// le moteur qui JOUE le fichier est celui dont on reprend la duree.
const PAR_EXTENSION = {
  vgm, vgz: vgm,
  mid: midi, midi: midi, smf: midi,
  wav, flac, ogg, oga: ogg, opus: ogg, mp3,
};

async function initialiser(options) {
  await Promise.all([vgmstream.initialiser(options), initialiserOpenmpt()]);
}

/** Une mesure est-elle possible pour cette extension ? */
function mesurable(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  return EXT_XSF.has(e) || e in PAR_EXTENSION || EXT_OPENMPT.has(e) || vgmstream.mesurable(e);
}

/** Voir l'en-tete du fichier pour ce que rend cette fonction. */
function mesurer(tampon, nomFichier, ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  try {
    if (EXT_XSF.has(e)) return xsf(tampon);
    if (e in PAR_EXTENSION) return PAR_EXTENSION[e](tampon);
    if (EXT_OPENMPT.has(e)) return tracker(tampon);
    if (vgmstream.mesurable(e)) return vgmstream.mesure(tampon, nomFichier);
  } catch (err) {
    return rien;
  }
  return undefined;
}

module.exports = { initialiser, mesurable, mesurer, _pourEssai: { xsf, vgm, midi, wav, flac, ogg, mp3 } };
