# Construit libkss en WebAssembly.
#
# Ce conteneur se lance A LA MAIN, et son resultat est commite dans src/ avec
# sa provenance. Voir scripts/emscripten/README.md.
#
# POURQUOI UN MOTEUR DE PLUS, ALORS QUE GME LIT DEJA LE .KSS
#
# Il le lit, mais mal. Releve sur « MSX/Snatcher » du catalogue de production,
# piste 104 (Theme of Snatcher) : la lecture avance bien a 1,00x, et GME expose
# les huit voix attendues — trois carres du PSG, cinq ondes du SCC — mais la
# crete tient en 0,04 sur vingt-deux secondes, contre 0,22 a 0,35 pour les
# autres fichiers du meme moteur. Voix par voix, quatre seulement sortent
# quelque chose. L'en-tete, lui, ne reclame aucune puce exotique. Ce n'est donc
# pas le fichier : c'est l'emulation KSS de GME.
#
# libkss est l'implementation de reference de ce format, par l'auteur du format
# lui-meme (Mitsutaka Okazaki). Elle embarque ses propres emulateurs de puces —
# emu2149 pour le PSG, emu2212 pour le SCC, emu2413 pour l'OPLL du FM-PAC,
# emu8950 pour le MSX-AUDIO, emu76489 pour le SN76489 du Master System — et le
# coeur Z80 kmz80. C'est du C pur, sans aucune dependance : la recette la plus
# legere du depot, et de loin.
#
# Ce qu'elle apporte en plus de la fidelite :
#   - l'intervalle de pistes REELLEMENT declare (trk_min..trk_max), la ou GME
#     annonce 256 morceaux dont la plupart sont vides ;
#   - la detection de fin et de boucle, quand le pilote la permet ;
#   - le Master System et la Game Gear, que le format KSS couvre aussi.

FROM emscripten/emsdk:6.0.0 AS build

# Version figee : une construction doit pouvoir etre refaite a l'identique.
ARG LIBKSS_COMMIT=2ed9588

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# --recursive est indispensable : les emulateurs de puces et le coeur Z80 sont
# des sous-modules, et sans eux le CMakeLists ne trouve aucune de ses cibles.
RUN git clone --recursive https://github.com/digital-sound-antiques/libkss.git libkss \
 && cd libkss && git checkout --recurse-submodules "$LIBKSS_COMMIT" \
 && git log -1 --format='libkss %H %ad' --date=short

WORKDIR /src/libkss
COPY shim.c src/shim.c

# KSS_bin2kss et non KSS_new : le second n'alloue que la structure et recopie
# les octets, sans lire l'en-tete. Le premier detecte le type du fichier, le
# confie au bon analyseur (KSS_kss2kss pour un .kss) puis renseigne titre,
# intervalle de pistes et puces presentes. Ouvrir avec KSS_new rendrait un
# objet d'apparence valide, a zero partout, et la lecture serait muette SANS
# erreur — exactement le genre de panne qui ne se voit qu'a l'oreille.

RUN mkdir -p embuild && cd embuild && emcmake cmake .. -DCMAKE_BUILD_TYPE=Release \
 && emmake make -j"$(nproc)" kss

# EXPORTED_FUNCTIONS n'est pas une liste de confort : tout ce qui n'y figure
# pas est elague par l'editeur de liens, et l'absence ne se verrait qu'a
# l'execution, sur un fichier particulier. Le garde-fou scripts/verify-wasm-abi.js
# relit cette liste depuis la colle produite et la confronte aux appels de src/.
RUN emcc -O3 \
      $(find embuild -name '*.a' | sort | tr '\n' ' ') \
      -I src -I modules \
      -o /tmp/libkss.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'libkss'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_KSS_bin2kss','_KSS_delete','_KSS_get_title','_KSS_check_type','_KSSPLAY_new','_KSSPLAY_set_data','_KSSPLAY_reset','_KSSPLAY_calc','_KSSPLAY_calc_silent','_KSSPLAY_delete','_KSSPLAY_get_loop_count','_KSSPLAY_get_stop_flag','_KSSPLAY_get_fade_flag','_KSSPLAY_fade_start','_KSSPLAY_fade_stop','_KSSPLAY_set_silent_limit','_KSSPLAY_set_device_mute','_KSSPLAY_set_device_volume','_KSSPLAY_set_master_volume','_KSSPLAY_set_channel_mask','_KSSPLAY_set_speed','_KSSPLAY_set_device_quality','_KSSPLAY_set_device_pan','_KSSPLAY_set_rcf','_KSSPLAY_set_dcf','_kssx_trk_min','_kssx_trk_max','_kssx_title','_kssx_mode','_kssx_kssx','_kssx_fmpac','_kssx_fmunit','_kssx_msx_audio','_kssx_sn76489','_kssx_stereo','_kssx_loop_detectable','_kssx_stop_detectable','_kssx_info_num','_kssx_info_song','_kssx_info_title','_kssx_info_time']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8','getValue','setValue']"

FROM scratch AS artifacts
COPY --from=build /tmp/libkss.js /libkss.js
COPY --from=build /tmp/libkss.wasm /libkss.wasm
