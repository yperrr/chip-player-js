# TIC-80 en WebAssembly : la console imaginaire de nesbox, pour jouer les
# cartouches .tic (src/players/Tic80Player.js).
#
#   docker build --target artifacts --output type=local,dest=../../../src .
#
# TIC-80 est sous licence MIT ; les interpretes compiles ici aussi (Lua :
# MIT, MoonScript : MIT, Fennel : MIT, QuickJS : MIT, Wren : MIT, Squirrel :
# MIT, s7 : 0BSD, pocketpy : MIT).
#
# On ne construit que le coeur (cible tic80core, sans studio, sans SDL ni
# Sokol), lie statiquement a ses interpretes, et notre facade shim.c par-dessus.
# Ruby et Janet sont ecartes : mruby se construit avec rake, absent de l image
# emsdk, et Janet amorce son amalgame en executant un janet NATIF ; leurs
# demos sont rarissimes. Idem pour wasm, MiniScript, Forth et
# Gravity.

FROM emscripten/emsdk:6.0.0 AS build
ARG TIC80_TAG=v1.4.1

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "$TIC80_TAG" https://github.com/nesbox/TIC-80.git tic \
 && git -C tic submodule update --init --depth 1 \
      vendor/lua vendor/moonscript vendor/fennel vendor/lpeg vendor/quickjs \
      vendor/wren vendor/squirrel vendor/janet vendor/pocketpy vendor/blip-buf \
      vendor/zlib vendor/zip vendor/libpng vendor/giflib vendor/argparse \
 && printf 'tic-80 %s %s\n' "$TIC80_TAG" "$(git -C tic rev-parse HEAD)" > /tmp/provenance.txt \
 && cat /tmp/provenance.txt

RUN mkdir -p /build && cd /build \
 && emcmake cmake /src/tic -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DBUILD_SDL=OFF -DBUILD_SOKOL=OFF -DBUILD_LIBRETRO=OFF -DBUILD_PLAYER=OFF \
      -DBUILD_STATIC=ON -DBUILD_EDITORS=OFF -DBUILD_SURF=OFF -DBUILD_TOOLS=OFF \
      -DBUILD_TOUCH_INPUT=OFF -DBUILD_WITH_ALL=OFF \
      -DBUILD_WITH_LUA=ON -DBUILD_WITH_MOON=ON -DBUILD_WITH_FENNEL=ON \
      -DBUILD_WITH_JS=ON -DBUILD_WITH_WREN=ON -DBUILD_WITH_SQUIRREL=ON \
      -DBUILD_WITH_SCHEME=ON -DBUILD_WITH_JANET=OFF -DBUILD_WITH_PYTHON=ON \
      -DBUILD_WITH_YUE=OFF -DBUILD_WITH_RUBY=OFF -DBUILD_WITH_WASM=OFF \
      -DBUILD_WITH_MINISCRIPT=OFF -DBUILD_WITH_FORTH=OFF -DBUILD_WITH_GRAVITY=OFF \
 && emmake make -j"$(nproc)" tic80core \
 && echo "tic-80 : coeur compile"

COPY shim.c /src/shim.c

# EXPORTED_FUNCTIONS : tout ce qui n'y figure pas est elague. Le garde-fou
# scripts/verify-wasm-abi.js relit cette liste et la confronte aux appels.
RUN cd /build \
 && emcc -O2 -c -I/src/tic/include -I/src/tic/src -DTIC_RUNTIME_STATIC /src/shim.c -o /build/shim.o \
 && em++ -O2 /build/shim.o -Wl,--start-group $(find /build -name '*.a') -Wl,--end-group -o /tmp/tic80.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'tic80'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s INITIAL_MEMORY=67108864 \
      -s STACK_SIZE=4194304 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_t8_create','_t8_load','_t8_error','_t8_tick','_t8_samples','_t8_screen','_t8_close']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','UTF8ToString']"

FROM scratch AS artifacts
COPY --from=build /tmp/tic80.js /tic80.js
COPY --from=build /tmp/tic80.wasm /tic80.wasm
COPY --from=build /tmp/provenance.txt /tic80-provenance.txt
