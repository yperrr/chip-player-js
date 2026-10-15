# Moteurs wasm construits à la main

Un dossier par bibliothèque, un `Dockerfile` chacun. Ces recettes **ne sont pas
lancées pendant la construction du lecteur** : leur résultat est commité dans
`src/`, accompagné d'un fichier de provenance.

C'est le même parti pris que pour `src/chip-core.js` : le dépôt reste
constructible sans chaîne C/C++, la CI ne dépend pas des serveurs amont, et une
construction donne toujours le même binaire que la veille.

## Reconstruire un moteur

```bash
cd scripts/emscripten/libopenmpt
docker build --target artifacts --output type=local,dest=../../../src .
```

Puis, à la racine du dépôt :

1. remettre l'en-tête `/*eslint-disable*/` en tête de la colle — elle est
   minifiée, le linter de CRA la refuserait ;
2. mettre à jour `src/<moteur>.provenance.json` (version, tailles, sha256) ;
3. vérifier l'ABI : `node scripts/verify-wasm-abi.js` ;
4. construire le lecteur et **éprouver sur de vrais fichiers** avant de commiter.

## Règle absolue

La colle et le `.wasm` viennent **toujours de la même exécution**. Les exports
du wasm sont minifiés en lettres et c'est la colle qui les mappe : mélanger deux
constructions casse tout, silencieusement d'abord.

## Pourquoi la cible `wasm`, et pas `audioworkletprocessor`

libopenmpt sait émettre un module ES destiné à tourner *dans* un
`AudioWorkletProcessor` — c'est ce que publie le paquet npm `chiptune3`. Ce
serait un second chemin audio, parallèle au nôtre.

Le lecteur a déjà payé ce prix une fois : la greffe `native-audio.js` jouait à
côté du graphe, et deux morceaux pouvaient se superposer. La cible `wasm` rend
un couple `.js`/`.wasm` ordinaire, que le lecteur pilote depuis son propre
`processAudioInner`, comme tous les autres moteurs.
