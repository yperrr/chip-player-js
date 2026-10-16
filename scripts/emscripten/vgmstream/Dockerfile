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
# 2. FFmpeg et libvorbis SONT construits, depuis le 2026-10-16.
#
#    Ils ne l'etaient pas d'abord, pour tenir la recette courte. Le prix s'est
#    mesure sur le catalogue de production, un fichier reel par extension : les
#    .at3 et .oma (ATRAC3) ne s'ouvraient pas, ni les .xma, ni les .logg, et
#    les .wem de Wwise s'ouvraient pour ne rendre que du silence — quatre
#    fichiers, quatre jeux. Soit pres de sept cents fichiers injouables chez
#    l'utilisateur, et 4 459 archives joshw annoncees a tort.
#
#    Ce qui a rendu la chose abordable : l'amont sait deja construire FFmpeg
#    SOUS EMSCRIPTEN (voir cmake/dependencies/ffmpeg.cmake, qui teste
#    explicitement la variable EMSCRIPTEN) et le configure avec une liste de
#    decodeurs taillee pour les jeux. Il n'y avait donc pas de portage a faire,
#    seulement des options a poser.
#
#    Restent OFF : libmpg123 (FFmpeg fournit deja mp3float), CELT, SPEEX et
#    G.719, qui ne concernent qu'une poignee de fichiers. La liste exacte de ce
#    que CE binaire sait lire est relevee a la construction, pas supposee :
#    voir vgmstream-extensions.json.

FROM emscripten/emsdk:6.0.0 AS build

ARG VGMSTREAM_VERSION=r2117
# Les cibles qui construisent FFmpeg lancent un `make` imbrique, que CMake
# appelle sans -j. MAKEFLAGS le leur transmet, sans quoi FFmpeg se compile sur
# un seul coeur.
ARG JOBS=8
ENV MAKEFLAGS=-j${JOBS}

RUN apt-get update && apt-get install -y --no-install-recommends \
      git pkg-config yasm \
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
      -DUSE_FFMPEG=ON \
      -DUSE_MPEG=OFF \
      -DUSE_VORBIS=ON \
      -DUSE_ATRAC9=ON \
      -DUSE_CELT=OFF \
      -DUSE_SPEEX=OFF \
      -DUSE_G719=OFF

# FFmpeg en deux temps, parce que ce sont deux cibles CMake distinctes et que
# la seconde depend d'un fichier que la premiere produit.
#
# L'amont configure FFmpeg lui-meme, et POUR EMSCRIPTEN : --enable-cross-compile,
# --target-os=none, --disable-asm, --disable-pthreads, plus une liste de
# decodeurs taillee pour les jeux — atrac3, atrac3p, xma1, xma2, wmav1, wmav2,
# wmapro, aac, ac3, opus, vorbis, flac, mp3float. On ne refait donc pas cette
# recette, on l'active. C'est ce qui rend ce changement petit.
RUN cd embuild && emmake make FFMPEG_CONFIGURE
RUN cd embuild && emmake make FFMPEG_MAKE

# libvorbis et libogg se construisent A PART, explicitement.
#
# L'amont les declare en EXCLUDE_FROM_ALL, et libvgmstream est une ARCHIVE
# statique : une archive ne lie rien, elle empile des objets. Construire
# `libvgmstream` ne tire donc pas ses dependances — ce sont ses consommateurs
# (la CLI, les greffons) qui les lient, et on les a desactives.
RUN cd embuild && emmake make -j"$(nproc)" ogg vorbis vorbisfile

RUN cd embuild && emmake make -j"$(nproc)" ATRAC9_MAKE libvgmstream

# Relie la bibliotheque statique en module ES, dans la forme de chip-core :
# une fabrique `export default vgmstream`.
#
# EXPORTED_FUNCTIONS n'est pas une liste de confort : tout ce qui n'y figure
# pas est elague par l'editeur de liens, et l'absence ne se verrait qu'a
# l'execution, sur un format particulier. Le garde-fou scripts/verify-wasm-abi.js
# relit cette liste depuis la colle produite et la confronte aux appels de src/.
#
# L'ORDRE DES ARCHIVES COMPTE. L'editeur de liens ne revient pas en arriere :
# une archive ne fournit que les symboles encore manquants au moment ou il la
# lit. libvgmstream appelle les codecs, les codecs appellent libavutil — d'ou
# ce classement, du plus demandeur au plus fournisseur. Les ranger autrement
# donne des « undefined symbol » sur des fonctions pourtant bien presentes.
#
# CHAQUE ARCHIVE EST EXIGEE, PAS SIMPLEMENT CHERCHEE. La premiere version de
# cette recette passait `$(find ... | head -1)` directement a emcc : une
# archive absente donnait une chaine VIDE, emcc liait sans elle, et l'erreur
# n'apparaissait que plus bas sous forme de symboles manquants — ou, pire,
# pas du tout si rien ne les appelait. On les resout donc d'abord, et on
# s'arrete net si l'une manque.
RUN set -eu; \
    archives=''; \
    for a in libvgmstream.a libatrac9.a libvorbisfile.a libvorbis.a libogg.a \
             libavformat.a libavcodec.a libswresample.a libavutil.a; do \
      f=$(find /src -name "$a" | head -1); \
      if [ -z "$f" ]; then echo "ARCHIVE MANQUANTE : $a" >&2; exit 1; fi; \
      echo "  $a -> $f"; \
      archives="$archives $f"; \
    done; \
    emcc -O3 \
      $archives \
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
RUN set -eu; \
    archives=''; \
    for a in libvgmstream.a libatrac9.a libvorbisfile.a libvorbis.a libogg.a \
             libavformat.a libavcodec.a libswresample.a libavutil.a; do \
      f=$(find /src -name "$a" | head -1); \
      if [ -z "$f" ]; then echo "ARCHIVE MANQUANTE : $a" >&2; exit 1; fi; \
      archives="$archives $f"; \
    done; \
    emcc -O1 \
      $archives \
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
