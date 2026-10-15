# Construit libopenmpt en WebAssembly.
#
# Ce conteneur se lance A LA MAIN, et son resultat est commite dans src/ avec
# sa provenance. Rien ne le tire pendant la construction du lecteur : le couple
# .js/.wasm est vendorise, exactement comme chip-core. La construction du
# frontend reste donc rapide et sans dependance reseau.
#
# Voir scripts/emscripten/README.md pour la marche a suivre.
#
# Recette inspiree de DrSnuggles/chiptune (MIT), adaptee sur deux points :
#
#  - cible `wasm` et non `audioworkletprocessor`. Celle-ci emet un vrai couple
#    libopenmpt.js + libopenmpt.wasm ; celle-la emet un module ES unique destine
#    a tourner DANS un AudioWorkletProcessor, c'est-a-dire son propre chemin
#    audio, parallele au notre. Le lecteur a deja paye ce prix une fois avec la
#    greffe native-audio.js, qui jouait a cote du graphe et provoquait des
#    lectures en double.
#
#  - MODULARIZE et EXPORT_ES6 ajoutes. La cible `wasm` pose EXPORT_NAME mais pas
#    MODULARIZE : sans lui la colle s'installe dans une variable globale au lieu
#    de rendre une fabrique. Avec, on obtient `export default libopenmpt`, et
#    `await import('../libopenmpt')` se comporte comme pour chip-core.

FROM emscripten/emsdk:6.0.0 AS build

# Version figee : une construction doit pouvoir etre refaite a l'identique.
ARG LIBOPENMPT_VERSION=0.8.9
ARG LIBOPENMPT_URL=https://lib.openmpt.org/files/libopenmpt/src

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN wget -q "$LIBOPENMPT_URL/libopenmpt-$LIBOPENMPT_VERSION+release.makefile.tar.gz" \
    && mkdir libopenmpt \
    && tar xzf "libopenmpt-$LIBOPENMPT_VERSION+release.makefile.tar.gz" \
         -C ./libopenmpt --strip-components=1

WORKDIR /src/libopenmpt

# Les symboles que le lecteur appelle. Par defaut la cible n'exporte que
# _malloc et _free : tout le reste serait elague par l'editeur de liens, et
# l'absence ne se verrait qu'a l'execution, sur un fichier particulier. Le
# garde-fou d'ABI (scripts/verify-wasm-abi.js) relit cette liste depuis la
# colle produite et la confronte aux appels presents dans src/.
RUN sed -i "s|^SO_LDFLAGS += -s EXPORTED_FUNCTIONS=.*|SO_LDFLAGS += -s EXPORTED_FUNCTIONS=\"['_malloc','_free','_openmpt_get_string','_openmpt_free_string','_openmpt_get_supported_extensions','_openmpt_module_create_from_memory2','_openmpt_module_destroy','_openmpt_module_read_float_stereo','_openmpt_module_get_duration_seconds','_openmpt_module_get_position_seconds','_openmpt_module_set_position_seconds','_openmpt_module_get_metadata','_openmpt_module_get_metadata_keys','_openmpt_module_get_num_subsongs','_openmpt_module_select_subsong','_openmpt_module_get_selected_subsong','_openmpt_module_get_subsong_name','_openmpt_module_get_num_channels','_openmpt_module_get_num_patterns','_openmpt_module_get_num_orders','_openmpt_module_get_num_instruments','_openmpt_module_get_num_samples','_openmpt_module_set_render_param','_openmpt_module_get_render_param','_openmpt_module_ctl_set_text','_openmpt_module_ctl_set_floatingpoint','_openmpt_module_set_repeat_count']\" -s EXPORTED_RUNTIME_METHODS=\"['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8','getValue','setValue']\"|" \
    build/make/config-emscripten.mk \
 && grep -q "openmpt_module_read_float_stereo" build/make/config-emscripten.mk

# MODULARIZE : voir l'en-tete. Ajoute apres les LDFLAGS de la cible pour ne pas
# dependre de l'ordre des regles du makefile amont.
RUN printf '\nLDFLAGS += -s MODULARIZE=1 -s EXPORT_ES6=1\n' >> build/make/config-emscripten.mk

# Deux passes, et c'est voulu.
#
# PASSE 1 — environnement par defaut, donc utilisable sous node. Elle ne sert
# qu'a demander sa liste d'extensions A LA BIBLIOTHEQUE, plutot que de la
# recopier a la main : elle est ainsi exacte pour CE binaire-ci et ne peut pas
# deriver. La liste est mise de cote avant la seconde passe.
RUN make -j"$(nproc)" CONFIG=emscripten EMSCRIPTEN_TARGET=wasm \
 && cd bin \
 && { \
      echo "import libopenmpt from './libopenmpt.js';"; \
      echo "const m = await libopenmpt();"; \
      echo "const p = m._openmpt_get_supported_extensions();"; \
      echo "const liste = m.UTF8ToString(p).split(';').filter(Boolean).sort();"; \
      echo "m._openmpt_free_string(p);"; \
      echo "process.stdout.write(JSON.stringify(liste, null, 1));"; \
    } > extensions.mjs \
 && node extensions.mjs > /tmp/libopenmpt-extensions.json \
 && echo "" >> /tmp/libopenmpt-extensions.json \
 && wc -c /tmp/libopenmpt-extensions.json

# PASSE 2 — environnement « web » seul, et c'est elle qu'on vendorise.
#
# Sans cela la colle garde sa branche node, qui fait `import('node:module')`.
# webpack, qui construit pour le navigateur, ne sait pas resoudre ce schema et
# s'arrete sur « UnhandledSchemeError: Reading from "node:module" ». C'est
# d'ailleurs ainsi qu'est bati le chip-core deja embarque : sa colle commence
# par `var ENVIRONMENT_IS_WEB=true`, en dur.
RUN printf '\nLDFLAGS += -s ENVIRONMENT=web\n' >> build/make/config-emscripten.mk \
 && rm -f bin/libopenmpt.js bin/libopenmpt.wasm \
 && make -j"$(nproc)" CONFIG=emscripten EMSCRIPTEN_TARGET=wasm \
 && cp /tmp/libopenmpt-extensions.json bin/libopenmpt-extensions.json \
 && head -c 60 bin/libopenmpt.js

# Etage de sortie : que les deux fichiers a vendoriser, rien d'executable.
FROM scratch AS artifacts
COPY --from=build /src/libopenmpt/bin/libopenmpt.js /libopenmpt.js
COPY --from=build /src/libopenmpt/bin/libopenmpt.wasm /libopenmpt.wasm
COPY --from=build /src/libopenmpt/bin/libopenmpt-extensions.json /libopenmpt-extensions.json
