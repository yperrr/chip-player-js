# FAKE-08 en WebAssembly : la console imaginaire PICO-8, pour jouer les
# cartouches .p8 et .p8.png (src/players/Pico8Player.js).
#
#   docker build --target artifacts --output type=local,dest=../../../src .
#
# FAKE-08 est sous licence MIT, ses dependances aussi (z8lua : MIT, zepto8 :
# WTFPL, lodepng : zlib, miniz : MIT). Il n'a aucun lien avec Lexaloffle et
# n'embarque rien de PICO-8 lui-meme.
#
# On compile les sources de son coeur libretro (platform/libretro/
# Makefile.common), sauf libretro.cpp, remplace par notre facade shim.cpp. Son
# hote libretro, lui, est repris tel quel : il n'est fait que de bouchons.

FROM emscripten/emsdk:6.0.0 AS build
ARG FAKE08_COMMIT=814991a2571ad3970e386cef48f3b148aa1c27b9

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/jtothebell/fake-08.git f8 \
 && git -C f8 checkout "$FAKE08_COMMIT" \
 && git -C f8 submodule update --init --recursive \
 && printf 'fake-08 %s\nz8lua   %s\n' "$(git -C f8 rev-parse HEAD)" "$(git -C f8/libs/z8lua rev-parse HEAD)" > /tmp/provenance.txt \
 && cat /tmp/provenance.txt

COPY shim.cpp /src/shim.cpp

# Memes sources et memes chemins d'inclusion que Makefile.common. z8lua est du
# C++ dans des fichiers .c (luaconf.h inclut <cstdint>) : compile comme tel.
# Exceptions C++ activees partout : z8lua, compile en C++, signale ses erreurs
# Lua par throw (LUAI_THROW), y compris celles qu un pcall rattrape. Sans
# -fexceptions, chaque erreur Lua devient un abort.
# ltests.c
# n'est compile que pour la forme, comme chez eux : il est vide hors LUA_DEBUG.
RUN mkdir -p /build && cd /build \
 && F=/src/f8 \
 && INC="-I$F/source -I$F/libs/z8lua -I$F/libs/lodepng -I$F/libs/miniz -I$F/libs/simpleini -I$F/platform/libretro" \
 && for c in $F/libs/z8lua/*.c; do \
      case "$(basename $c)" in lua.c|luac.c|onelua.c) continue ;; esac; \
      em++ -O2 -c -w -fexceptions -x c++ -std=c++17 $INC "$c" -o "l_$(basename $c .c).o" || exit 1; \
    done \
 && for c in $F/libs/simpleini/ConvertUTF.c $F/libs/miniz/miniz.c; do \
      emcc -O2 -c -w $INC "$c" -o "c_$(basename $c .c).o" || exit 1; \
    done \
 && for c in $F/platform/libretro/libretrohost.cpp $F/libs/lodepng/lodepng.cpp \
             $F/source/Audio.cpp $F/source/Input.cpp $F/source/cart.cpp $F/source/emojiconversion.cpp \
             $F/source/filehelpers.cpp $F/source/filter.cpp $F/source/fontdata.cpp $F/source/graphics.cpp \
             $F/source/hostCommonFunctions.cpp $F/source/logger.cpp $F/source/mathhelpers.cpp \
             $F/source/nibblehelpers.cpp $F/source/picoluaapi.cpp $F/source/printHelper.cpp \
             $F/source/stringToDataHelpers.cpp $F/source/synth.cpp $F/source/vm.cpp /src/shim.cpp; do \
      em++ -O2 -c -w -fexceptions -std=c++17 -D__LIBRETRO__ $INC "$c" -o "x_$(basename $c .cpp).o" || exit 1; \
    done \
 && echo "fake-08 : sources compilees"

# EXPORTED_FUNCTIONS : tout ce qui n'y figure pas est elague. Le garde-fou
# scripts/verify-wasm-abi.js relit cette liste et la confronte aux appels.
RUN cd /build \
 && em++ -O2 -fexceptions *.o -o /tmp/fake08.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'fake08'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s INITIAL_MEMORY=33554432 \
      -s STACK_SIZE=1048576 \
      -s FORCE_FILESYSTEM=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_f8_init','_f8_load','_f8_error','_f8_step','_f8_fps','_f8_audio','_f8_screen','_f8_close']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','UTF8ToString']"

FROM scratch AS artifacts
COPY --from=build /tmp/fake08.js /fake08.js
COPY --from=build /tmp/fake08.wasm /fake08.wasm
COPY --from=build /tmp/provenance.txt /fake08-provenance.txt
