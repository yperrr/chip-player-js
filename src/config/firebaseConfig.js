// Configuration Firebase du client.
//
// L'amont ne versionne pas ce fichier (il est dans .gitignore) : chacun y pose
// la sienne, et le build echoue sans lui — « Can't resolve '../config/
// firebaseConfig' ». Ici, il ne contient AUCUNE valeur : ce serait figer un
// projet dans l'image, et ce depot est public.
//
// Trois sources, dans cet ordre :
//
//   1. window.__chipFirebaseConfig — pose a l'execution par le serveur, donc
//      modifiable sans reconstruire l'image. C'est la voie de production :
//      firebase-config-runtime.js de la stack ecrit ce fichier au demarrage
//      depuis config/firebaseConfig.json.
//   2. REACT_APP_FIREBASE_CONFIG — JSON fige au build, pour un deploiement
//      statique sans serveur.
//   3. un objet vide — l'application demarre, seule la connexion est inerte.
//
// Cet ordre remplace la transformation 4 de l'ancien patch.js, qui cherchait
// dans le bundle minifie tout objet portant a la fois apiKey, authDomain et
// projectId pour l'envelopper. Il reste ici une seule phrase a lire.

function depuisEnvironnement() {
  const brut = process.env.REACT_APP_FIREBASE_CONFIG;
  if (!brut) return null;
  try {
    return JSON.parse(brut);
  } catch (e) {
    console.error('REACT_APP_FIREBASE_CONFIG : JSON invalide, ignore.', e.message);
    return null;
  }
}

// Lu a chaque acces plutot qu'une fois au chargement du module : le script qui
// pose window.__chipFirebaseConfig n'est pas differe, mais rien ne garantit
// l'ordre si la page evolue.
const config =
  (typeof window !== 'undefined' && window.__chipFirebaseConfig) ||
  depuisEnvironnement() ||
  {};

if (!config.apiKey) {
  console.warn(
    'Firebase : aucune configuration (ni window.__chipFirebaseConfig, ni ' +
    'REACT_APP_FIREBASE_CONFIG). Comptes et favoris seront indisponibles.');
}

export default config;
