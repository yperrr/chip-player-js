// Adresse publique du site, pour tout ce que le serveur rend a l'avance :
// balises Open Graph, lien canonique, donnees structurees JSON-LD.
//
// POURQUOI CE FICHIER EXISTE
//
// Ces URL etaient ecrites en dur — « https://chiptune.app » — a dix-huit
// endroits de server/. Un site auto-heberge se retrouvait alors a annoncer le
// domaine d'un autre : balises og:url, twitter:url, image de partage, et
// surtout <link rel="canonical">, qui dit aux moteurs de recherche « la vraie
// page est ailleurs ». Sur les pages /browse, dix occurrences par page.
//
// Le contournement habituel etait de reecrire ces chaines a la construction,
// avec un sed. Il passait a cote de server/directory-metadata.js, arrive plus
// tard en amont : un fichier de plus, une liste de sed a rallonger, et la fuite
// revenait sans bruit. D'ou cette variable, sur le meme principe que les
// REACT_APP_* de src/config/index.js cote client.
//
// La valeur par defaut reste le site amont : sans configuration, rien ne change.
const SITE_URL = (process.env.CHIP_PUBLIC_URL || 'https://chiptune.app').replace(/\/+$/, '');

module.exports = { SITE_URL };
