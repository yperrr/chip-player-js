import Player from './Player.js';
import autoBind from 'auto-bind';

// Seule l'extension .kss est revendiquee.
//
// libkss sait aussi ouvrir du MGS, du BGM, de l'OPX, du MPK et du MBM, mais
// chacun de ces formats est un FICHIER DE DONNEES pour un pilote MSX qu'il faut
// fournir a part (KSS_set_mgsdrv, KSS_set_opxdrv…). Ces pilotes sont des
// binaires MSX sous licences diverses, que le depot n'embarque pas : les
// declarer ici ferait apparaitre au catalogue des fichiers qui echoueraient a
// l'ouverture.
const fileExtensions = ['kss'];

// src/kss/kss.h : KSS_DEVICE
const DEVICE_PSG = 0;
const DEVICE_SCC = 1;
const DEVICE_OPLL = 2;
const DEVICE_OPL = 3;

// src/kssplay.h : enum de KSSPLAY_get_fade_flag()
const FADE_END = 2;

// Le volume de libkss se compte en pas, pas en decibels. make_voltable() pose
// volume_table[i] = 4096 * 2^(i / 32) : trente-deux pas valent donc exactement
// six decibels, et un pas 0,1875 dB.
const PAS_PAR_DB = 32 / 6;

// Un KSS ne porte pas de duree : c'est un programme Z80, il joue tant qu'on le
// laisse tourner. On retient la meme convention que GME pour ses formats sans
// duree, et la detection de boucle ci-dessous ecourte quand le pilote le
// permet.
const DUREE_DEFAUT_MS = 150000;

// Nombre de boucles avant le fondu, et sa duree. Deux passages suffisent a
// faire entendre le morceau entier sans le laisser tourner indefiniment.
const BOUCLES_AVANT_FONDU = 2;
const FONDU_MS = 4000;

// Au-dela, une recherche en avant couterait plus cher que ce qu'elle rapporte :
// calc_silent fait tourner le Z80 et les puces, simplement sans ecrire le son.
// Trois minutes d'emulation muette prennent une fraction de seconde, mais la
// borne evite qu'un fichier a duree absurde fige l'onglet.
const SECONDES_RECHERCHE_MAX = 600;

/**
 * Lecteur KSS (MSX, Master System, Game Gear), par libkss.
 *
 * POURQUOI CE MOTEUR, ALORS QUE GME LIT DEJA LE .KSS
 *
 * Parce qu'il le lit mal. Releve sur « MSX/Snatcher » du catalogue de
 * production, piste 104 : la lecture avance a 1,00x et GME expose bien les huit
 * voix attendues — trois carres du PSG, cinq ondes du SCC — mais la crete tient
 * en 0,04 sur vingt-deux secondes, la ou les autres fichiers du meme moteur
 * donnent 0,22 a 0,35. Voix par voix, quatre seulement sortent quelque chose.
 * L'en-tete du fichier ne reclame pourtant aucune puce exotique.
 *
 * libkss est l'implementation de reference du format, par son auteur. Elle
 * apporte en outre l'intervalle de pistes REELLEMENT declare par le fichier —
 * la ou GME annonce 256 morceaux dont la plupart sont vides.
 *
 * ARBITRAGE : ce lecteur est place AVANT GMEPlayer dans src/components/App.js.
 * Le sequenceur retient le premier moteur qui accepte l'extension ; GME garde
 * la sienne et reste le filet si l'on voulait revenir en arriere.
 */
export default class KSSPlayer extends Player {
  paramDefs = [
    {
      id: 'kssQuality',
      label: 'Chip Emulation',
      type: 'enum',
      options: [{
        label: 'Quality',
        items: [
          { label: 'Fast', value: 0 },
          { label: 'Accurate', value: 1 },
        ],
      }],
      defaultValue: 1,
    },
    {
      id: 'stereoSeparation',
      label: 'Stereo Separation',
      type: 'number',
      min: 0,
      max: 100,
      step: 5,
      // Le MSX sort un signal mono. L'ecart est une commodite d'ecoute, pas
      // une restitution : il est donc nul par defaut.
      defaultValue: 0,
    },
    {
      // Gain de sortie, en decibels.
      //
      // libkss rend a 0 dB, et c'est bien son niveau de reference : l'exemple
      // kss2wav de l'amont ne touche pas non plus au volume maitre. Mais un
      // MSX sort peu : releve sur « Snatcher » piste 104, vingt-huit secondes,
      // la crete moyenne est de 0,080 et le maximum de 0,100, quand les autres
      // moteurs du lecteur tiennent 0,22 a 0,35 sur le meme chemin audio. Dans
      // un catalogue qui melange les machines, le MSX passe donc pour muet.
      //
      // +6 dB le remet dans la meme plage en laissant cinq fois la marge avant
      // saturation. Qui veut le niveau de la bibliotheque met 0.
      id: 'kssGain',
      label: 'Output Gain (dB)',
      type: 'number',
      min: 0,
      max: 18,
      step: 1,
      defaultValue: 6,
    },
  ];

  constructor(core, sampleRate, bufferSize = 2048, debug = false) {
    // Pas de coeur a la construction : charge au premier fichier, comme
    // OpenMPTPlayer et VGMStreamPlayer. Le wasm pese 155 ko, contre 1,2 Mo
    // pour ceux-la — mais le principe vaut quand meme : une page qui ne lira
    // jamais de MSX n'a pas a le telecharger.
    super(null, sampleRate, bufferSize, debug);
    autoBind(this);

    this.playerKey = 'kss';
    this.name = 'KSS Player';
    this.fileExtensions = fileExtensions;
    this.kss = 0;            // KSS*
    this.play = 0;           // KSSPLAY*
    this.buf = 0;            // tampon entrelace int16
    this._echantillons = 0;  // rendus depuis le debut de la piste
    this._piste = 0;         // numero de morceau, dans la numerotation du fichier
    this._pisteMin = 0;
    this._pisteMax = 0;
    this._dureeMs = DUREE_DEFAUT_MS;
    this._fonduLance = false;
    this.infoTexts = [];
  }

  async _assurerLeCoeur() {
    if (this.core) return;
    const mod = await import('../libkss');
    this.core = await mod.default();
    // stereo, 16 bits : 2 canaux * 2 octets par echantillon.
    this.buf = this.core._malloc(this.bufferSize * 2 * 2);
  }

  _libererKss() {
    if (this.play) { this.core._KSSPLAY_delete(this.play); this.play = 0; }
    if (this.kss) { this.core._KSS_delete(this.kss); this.kss = 0; }
  }

  _appliquerReglages() {
    if (!this.play) return;
    const q = parseInt(this.getParameter('kssQuality'), 10);
    const qualite = Number.isNaN(q) ? 1 : q;
    for (const dev of [DEVICE_PSG, DEVICE_SCC, DEVICE_OPLL, DEVICE_OPL]) {
      this.core._KSSPLAY_set_device_quality(this.play, dev, qualite);
    }
    // L'ecart stereo se fait par panoramique de puce : le PSG d'un cote, le
    // SCC de l'autre. A 0, tout reste au centre et la sortie est celle de la
    // machine.
    const e = parseInt(this.getParameter('stereoSeparation'), 10) || 0;
    const pan = Math.round((e / 100) * 32);
    this.core._KSSPLAY_set_device_pan(this.play, DEVICE_PSG, -pan);
    this.core._KSSPLAY_set_device_pan(this.play, DEVICE_SCC, pan);

    // Le volume se compte en pas de la table de libkss, pas en decibels :
    // volume_table[i] = 4096 * 2^(i/32), soit exactement PAS_PAR_DB par dB.
    const db = parseInt(this.getParameter('kssGain'), 10) || 0;
    this.core._KSSPLAY_set_master_volume(this.play, Math.round(db * PAS_PAR_DB));
  }

  _demarrerPiste(piste) {
    this.core._KSSPLAY_reset(this.play, piste, 0);
    this._piste = piste;
    this._echantillons = 0;
    this._fonduLance = false;
    this._appliquerReglages();
  }

  processAudioInner(channels) {
    if (this.paused || !this.play) {
      for (let ch = 0; ch < channels.length; ch++) channels[ch].fill(0);
      return;
    }

    const c = this.core;
    const n = channels[0].length;
    c._KSSPLAY_calc(this.play, this.buf, n);
    this._echantillons += n;

    // Entrelace stereo 16 bits -> canaux flottants.
    const src = c.HEAP16.subarray(this.buf >> 1, (this.buf >> 1) + n * 2);
    for (let ch = 0; ch < channels.length; ch++) {
      const dec = Math.min(ch, 1);
      const sortie = channels[ch];
      for (let i = 0; i < n; i++) sortie[i] = src[i * 2 + dec] / 32768;
    }

    // Fin de morceau. Trois signaux, du plus sur au plus approximatif :
    //   - le pilote s'est arrete de lui-meme, ou n'a plus rien emis pendant la
    //     duree de silence toleree (stop_flag) ;
    //   - le fondu lance apres deux boucles est arrive a son terme ;
    //   - a defaut, la duree conventionnelle.
    if (c._KSSPLAY_get_stop_flag(this.play)) { this.handleSongEnd(); return; }
    if (c._KSSPLAY_get_fade_flag(this.play) === FADE_END) { this.handleSongEnd(); return; }
    if (!this._fonduLance) {
      const boucles = c._KSSPLAY_get_loop_count(this.play);
      const trop = this._echantillons / this.sampleRate >= this._dureeMs / 1000;
      if (boucles >= BOUCLES_AVANT_FONDU || trop) {
        this._fonduLance = true;
        c._KSSPLAY_fade_start(this.play, FONDU_MS);
      }
    }
  }

  async loadData(data, filename, persistedSettings = {}) {
    await this._assurerLeCoeur();
    this.filepathMeta = Player.metadataFromFilepath(filename);
    this._libererKss();

    // KSS_bin2kss et non KSS_new : celui-la n'alloue que la structure et
    // recopie les octets, sans lire l'en-tete. Celui-ci detecte le type, le
    // confie au bon analyseur et renseigne titre, intervalle de pistes et
    // puces. Le nom de fichier lui sert a departager les formats que
    // l'en-tete seul ne distingue pas.
    const dataPtr = this.copyToHeap(data);
    const nom = filename.split('/').pop();
    const nomPtr = this.core._malloc(this.core.lengthBytesUTF8(nom) + 1);
    this.core.stringToUTF8(nom, nomPtr, this.core.lengthBytesUTF8(nom) + 1);
    this.kss = this.core._KSS_bin2kss(dataPtr, data.length, nomPtr);
    this.core._free(nomPtr);
    this.core._free(dataPtr);
    if (!this.kss) throw Error('libkss: fichier KSS non reconnu');

    // Avant toute lecture de metadonnees : celles-ci cherchent la duree
    // declaree POUR LA PISTE COURANTE, et un fichier dont trk_min ne vaut pas
    // zero aurait sinon vu interroger une piste qui n'existe pas.
    this._piste = this.core._kssx_trk_min(this.kss);

    this.play = this.core._KSSPLAY_new(this.sampleRate, 2, 16);
    if (!this.play) { this._libererKss(); throw Error('libkss: KSSPLAY_new a echoue'); }
    this.core._KSSPLAY_set_data(this.play, this.kss);

    // Silence prolonge = morceau fini. Sans cette limite, les pistes vides
    // d'un fichier tourneraient sans fin — et un KSS en compte beaucoup : un
    // en-tete KSCC ne porte aucun index, il declare 256 morceaux et c'est au
    // lecteur de trouver lesquels existent. Sur « Snatcher », le premier
    // audible est le 104e.
    //
    // La bibliotheque se donne cinq secondes (KSSPLAY_new). On en retient une
    // et demie, et ce n'est pas imprudent : le detecteur ne compare pas un
    // NIVEAU mais deux echantillons consecutifs, et ne compte que s'ils sont
    // identiques au bit pres. Un passage calme continue de varier ; seul du
    // silence numerique franc declenche. Raccourcir ne fait donc que traverser
    // plus vite les pistes vides — a cinq secondes, atteindre la 104e depuis la
    // premiere demandait plus de huit minutes.
    this.core._KSSPLAY_set_silent_limit(this.play, 1500);

    this._lireMetadonnees();
    this.resolveParamValues(persistedSettings);
    this._demarrerPiste(this._pisteMin);
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  _chaine(ptr) {
    return ptr ? this.core.UTF8ToString(ptr) : '';
  }

  _lireMetadonnees() {
    const c = this.core;
    this._pisteMin = c._kssx_trk_min(this.kss);
    this._pisteMax = c._kssx_trk_max(this.kss);
    if (this._pisteMax < this._pisteMin) this._pisteMax = this._pisteMin;

    const machines = ['MSX', 'Sega Master System', 'Game Gear'];
    const puces = ['PSG'];
    if (c._kssx_fmpac(this.kss)) puces.push('FM-PAC (YM2413)');
    if (c._kssx_fmunit(this.kss)) puces.push('FM Unit');
    if (c._kssx_msx_audio(this.kss)) puces.push('MSX-AUDIO (Y8950)');
    if (c._kssx_sn76489(this.kss)) puces.push('SN76489');

    // La duree annoncee par le fichier, quand il en porte une (en-tete KSSX).
    let duree = 0;
    const nbInfos = c._kssx_info_num(this.kss);
    for (let i = 0; i < nbInfos; i++) {
      if (c._kssx_info_song(this.kss, i) === this._piste) {
        const t = c._kssx_info_time(this.kss, i);
        if (t > 0) duree = t;
      }
    }
    this._dureeMs = duree || DUREE_DEFAUT_MS;

    const titreFichier = this._chaine(c._kssx_title(this.kss)).trim();
    this.metadata = {
      title: titreFichier || this.filepathMeta.title,
      system: machines[c._kssx_mode(this.kss)] || 'MSX',
      play_length: this._dureeMs,
    };

    const textes = [
      'Format: ' + (c._kssx_kssx(this.kss) ? 'KSSX' : 'KSS'),
      'Chips: ' + puces.join(', '),
      'Tracks: ' + this._pisteMin + '-' + this._pisteMax,
    ];
    this.infoTexts = [textes.join('\n')];
  }

  getMetadata() { return this.metadata || {}; }

  getInfoTexts() { return this.infoTexts; }

  getDurationMs() { return this._dureeMs; }

  getPositionMs() {
    return (this._echantillons / this.sampleRate) * 1000;
  }

  /**
   * Recherche par reemulation.
   *
   * libkss n'expose pas de position : un KSS est un programme, l'etat du
   * morceau tient dans la memoire du Z80 et des puces. Pour aller a t, on
   * repart du debut et on fait tourner la machine SANS ecrire de son, ce qui
   * est precisement le role de calc_silent. Aller en arriere coute donc le
   * meme prix qu'aller en avant, et c'est la seule facon d'etre exact.
   */
  seekMs(ms) {
    if (!this.play) return;
    const cible = Math.max(0, Math.min(ms, SECONDES_RECHERCHE_MAX * 1000));
    const vises = Math.round((cible / 1000) * this.sampleRate);
    this._demarrerPiste(this._piste);
    // Par tranches : calc_silent travaille sur un entier non signe, et des
    // tranches gardent la boucle lisible si l'on veut un jour y rendre la main.
    const tranche = this.sampleRate;
    let reste = vises;
    while (reste > 0) {
      const n = Math.min(tranche, reste);
      this.core._KSSPLAY_calc_silent(this.play, n);
      reste -= n;
    }
    this._echantillons = vises;
  }

  getNumSubtunes() {
    return this._pisteMax - this._pisteMin + 1;
  }

  getSubtune() {
    return this._piste - this._pisteMin;
  }

  playSubtune(subtune) {
    if (!this.play) return;
    const piste = Math.max(this._pisteMin, Math.min(this._pisteMin + subtune, this._pisteMax));
    this._demarrerPiste(piste);
    this._lireMetadonnees();
    this.resume();
    this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
  }

  // Pas de getTempo / setTempo, volontairement.
  //
  // Le seul reglage de vitesse qu'offre libkss est KSSPLAY_set_speed, et ce
  // n'est pas un tempo : c'est un MULTIPLICATEUR ENTIER de l'horloge du Z80
  // (0 = automatique, 1 a 8 = x1 a x8, au-dela la valeur est ignoree et
  // l'horloge revient au nominal — voir getclk() dans kssplay.c). Le brancher
  // sur la vitesse continue du lecteur donnerait x1 pour 0,5 comme pour 1,4,
  // puis un retour silencieux au nominal des 0,09. N64Player et
  // VGMStreamPlayer ne l'exposent pas non plus : la classe de base s'en
  // accommode.

  setParameter(id, value) {
    super.setParameter(id, value);
    this._appliquerReglages();
  }

  stop() {
    this.suspend();
    this._libererKss();
    this._echantillons = 0;
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
