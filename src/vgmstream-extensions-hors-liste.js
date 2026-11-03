// Ce que notre vgmstream LIT sans que la bibliotheque le DECLARE.
//
// vgmstream-extensions.json est releve sur le binaire, a la construction, en
// appelant libvgmstream_get_extensions(). C'est la bonne source — sauf qu'elle
// repond a une autre question que la notre. Elle dit ce que la bibliotheque
// revendique ; nous voulons ce qu'elle sait ouvrir. Les deux different quand
// l'amont s'abstient par convention.
//
// « wma » est ce cas. vgmstream connait parfaitement le format — « asf »,
// « lwma » et « xwma » figurent dans sa liste, et FFmpeg, construit dans notre
// recette depuis le 2026-10-16, fournit wmav1, wmav2 et wmapro — mais il
// laisse l'extension elle-meme aux lecteurs de bureau, comme il laisse « mp3 »
// et « ogg », et propose « lwma » a qui veut la lui confier. Le navigateur, de
// son cote, ne sait pas lire le WMA : canPlayType('audio/x-ms-wma') rend ""
// sous Chrome comme sous Firefox, et NativeAudioPlayer se filtre la-dessus.
// Sans cette ligne, un .wma n'est donc lu par personne.
//
// MESURE, sur un fichier de 3 s encode en wmav1 et en wmav2, puis sur le meme
// contenu renomme en .lwma, .xwma et .asf — les cinq se comportent a
// l'identique :
//   ouvert par le meta « FFmpeg format (ASF (Advanced / Active Streaming
//   Format)) », codec « Windows Media Audio 1 / 2 », 44 100 Hz, 2 s decodees
//   en 87 blocs, crete 0,126.
// Cette crete est exactement ce que ffmpeg lui-meme rend sur le fichier
// (volumedetect : max_volume -18,0 dB, soit 0,126 en lineaire). Le controle
// importe : un format peut s'ouvrir et ne rendre que du silence — c'est ce
// que faisait le .wem avant que FFmpeg soit ajoute a la recette.
//
// Ce module est en CommonJS a dessein, comme src/config/index.js : il est lu
// aussi bien par le bundle (src/players/VGMStreamPlayer.js) que par Node
// (scripts/duration-vgmstream.js), et une liste tenue a deux endroits derive.
module.exports = [
  'wma',
];
