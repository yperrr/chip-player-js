# Construit vgmstream en WebAssembly.
#
# Meme parti pris que pour libopenmpt : ce conteneur se lance A LA MAIN, et son
# resultat est commite dans src/ avec sa provenance. Voir
# scripts/emscripten/README.md.
#
# Ce que vgmstream apporte : les flux audio des consoles, c'est-a-dire la part
# la plus lourde de joshw — adpcm GameCube/Wii (dsp, bfstm, afc), ima, at9,
# et bien d'autres. Releve sur l'index joshw : 17 074 archives sur 53 667, soit
# 31,8 %, contre 16,7 % lisibles aujourd'hui tous formats confondus.
#
# DEUX CHOIX A EXPLIQUER
#
# 1. La cible officielle de vgmstream sous emscripten est `vgmstream-cli`, un
#    programme pilote par callMain() : il faudrait decoder la piste entiere en
#    memoire avant la premiere note (cinq minutes de stereo 48 kHz font ~57 Mo).
#    On construit donc la BIBLIOTHEQUE et on relie nous-memes son API publique
#    (src/libvgmstream.h), qui sait decoder en flux : libvgmstream_fill() rend
#    un tampon a la fois, exactement ce dont processAudioInner a besoin.
#
# 2. Pas de FFmpeg, ni libmpg123, ni libvorbis. Les construire pour wasm
#    tripleraait la recette et le poids. Consequence assumee et mesurable : les
#    codecs qui en dependent (atrac3, xma, wma) restent hors de portee, tandis
#    qu'atrac9, G.722.1, CELT et SPEEX sont fournis par vgmstream lui-meme et
#    restent disponibles. La liste exacte est relevee a la construction, pas
#    supposee : voir vgmstream-extensions.json.

FROM emscripten/emsdk:6.0.0 AS build

ARG VGMSTREAM_VERSION=r2117

RUN apt-get update && apt-get install -y --no-install-recommends \
      git pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "$VGMSTREAM_VERSION" \
      https://github.com/vgmstream/vgmstream.git vgmstream

WORKDIR /src/vgmstream
RUN mkdir -p embuild && cd embuild && emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_CLI=OFF \
      -DBUILD_V123=OFF \
      -DBUILD_AUDACIOUS=OFF \
      -DUSE_FFMPEG=OFF \
      -DUSE_MPEG=OFF \
      -DUSE_VORBIS=OFF \
      -DUSE_ATRAC9=ON \
      -DUSE_CELT=OFF \
      -DUSE_SPEEX=OFF \
      -DUSE_G719=OFF \
 && emmake make -j"$(nproc)" ATRAC9_MAKE libvgmstream

# Relie la bibliotheque statique en module ES, dans la forme de chip-core :
# une fabrique `export default vgmstream`.
#
# EXPORTED_FUNCTIONS n'est pas une liste de confort : tout ce qui n'y figure
# pas est elague par l'editeur de liens, et l'absence ne se verrait qu'a
# l'execution, sur un format particulier. Le garde-fou scripts/verify-wasm-abi.js
# relit cette liste depuis la colle produite et la confronte aux appels de src/.
RUN emcc -O3 \
      $(find embuild -name 'libvgmstream.a' | head -1) \
      $(find / -name 'libatrac9.a' 2>/dev/null | head -1) \
      -I src \
      -o /tmp/vgmstream.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'vgmstream'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s FORCE_FILESYSTEM=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_libvgmstream_init','_libvgmstream_free','_libvgmstream_setup','_libvgmstream_open_stream','_libvgmstream_close_stream','_libvgmstream_create','_libvgmstream_render','_libvgmstream_fill','_libvgmstream_get_play_position','_libvgmstream_seek','_libvgmstream_reset','_libvgmstream_get_version','_libvgmstream_get_extensions','_libvgmstream_get_common_extensions','_libstreamfile_open_from_stdio','_libstreamfile_close','_libvgmstream_set_log']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8','getValue','setValue','FS']"

# La liste des extensions est demandee A LA BIBLIOTHEQUE. Elle demande un
# module utilisable sous node, donc une seconde edition de liens sans
# ENVIRONMENT=web — le binaire vendorise, lui, reste web.
RUN emcc -O1 \
      $(find embuild -name 'libvgmstream.a' | head -1) \
      $(find / -name 'libatrac9.a' 2>/dev/null | head -1) \
      -I src -o /tmp/probe.js \
      -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME="'vgmstream'" \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_libvgmstream_get_extensions','_libvgmstream_get_version']" \
      -s EXPORTED_RUNTIME_METHODS="['UTF8ToString','getValue']" \
 && cd /tmp && { \
      echo "import vgmstream from './probe.js';"; \
      echo "const m = await vgmstream();"; \
      echo "const nPtr = m._malloc(4);"; \
      echo "const tab = m._libvgmstream_get_extensions(nPtr);"; \
      echo "const n = m.getValue(nPtr, 'i32');"; \
      echo "const liste = [];"; \
      echo "for (let i = 0; i < n; i++) liste.push(m.UTF8ToString(m.getValue(tab + i * 4, '*')));"; \
      echo "m._free(nPtr);"; \
      echo "process.stdout.write(JSON.stringify(liste.sort(), null, 1));"; \
    } > probe.mjs \
 && node probe.mjs > /tmp/vgmstream-extensions.json \
 && echo "" >> /tmp/vgmstream-extensions.json \
 && head -c 200 /tmp/vgmstream-extensions.json

FROM scratch AS artifacts
COPY --from=build /tmp/vgmstream.js /vgmstream.js
COPY --from=build /tmp/vgmstream.wasm /vgmstream.wasm
COPY --from=build /tmp/vgmstream-extensions.json /vgmstream-extensions.json
