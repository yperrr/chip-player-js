# Construit la famille *Sound Format* en WebAssembly : PSF, SSF, DSF.
#
# Ce conteneur se lance A LA MAIN, et son resultat est commite dans src/ avec
# sa provenance. Voir scripts/emscripten/README.md.
#
# CE QUE CE MOTEUR N'EST PAS
#
# Ce n'est pas un decodeur. Un .psf ne contient pas de son : il contient le
# PROGRAMME de la machine, celui que le jeu executait pour piloter sa puce
# audio, plus les echantillons dont il se sert. Le lire demande donc d'emuler
# la machine — un R3000 et son SPU pour la PlayStation, un SH-2 et le SCSP pour
# la Saturn, un ARM7 et l'AICA pour la Dreamcast. C'est pourquoi la famille
# etait restee hors perimetre quand vgmstream et libopenmpt ont ete ajoutes :
# un codec se branche, une machine se simule.
#
# TROIS BRIQUES, TOUTES DE CHRISTOPHER SNOWHILL ET NEILL CORLETT
#
#   psflib              le conteneur. Un .psf, un .ssf et un .dsf sont le meme
#                       fichier a un octet pres — 0x01, 0x11, 0x12 — avec un
#                       programme compresse en zlib et des etiquettes qui
#                       renvoient a des fichiers voisins par _lib, _lib2…
#                       psf_load() demele la recursion et livre les morceaux
#                       dans le bon ordre.
#   Highly_Experimental le coeur PlayStation (et PlayStation 2, non utilise
#                       ici : le PSF2 demande en plus un systeme de fichiers
#                       virtuel, psf2fs).
#   Highly_Theoretical  les coeurs Saturn et Dreamcast, choisis par un numero
#                       de version a l'initialisation de l'etat.
#
# Les trois sont du C ordinaire. La seule dependance exterieure est zlib, que
# le portage emscripten fournit en port officiel (--use-port=zlib).

FROM emscripten/emsdk:6.0.0 AS build

# Versions figees : une construction doit pouvoir etre refaite a l'identique.
ARG PSFLIB_COMMIT=95509e0c6f13d769593bbf51a1b0e0efdc355ba1
ARG HE_COMMIT=ccffd7b5f21ab8feaed78544b677e7da0ad43ce7
ARG HT_COMMIT=2998a4bf550949cd2daee249e725a64462cf15e0

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/kode54/psflib.git psflib \
 && git clone https://github.com/kode54/Highly_Experimental.git he \
 && git clone https://github.com/kode54/Highly_Theoretical.git ht \
 && git -C psflib checkout "$PSFLIB_COMMIT" \
 && git -C he checkout "$HE_COMMIT" \
 && git -C ht checkout "$HT_COMMIT" \
 && for d in psflib he ht; do \
      printf '%-10s %s\n' "$d" "$(git -C $d rev-parse HEAD)"; \
    done | tee /tmp/provenance.txt

COPY shim.c /src/shim.c

# EMU_COMPILE et EMU_LITTLE_ENDIAN sont exiges par emuconfig.h, qui refuse de
# compiler sans : « Hi I forgot to set EMU_COMPILE ». Ce ne sont pas des
# options de confort mais la declaration, par le projet integrateur, qu'il
# compile bien la bibliotheque et sur quelle architecture — wasm est
# petit-boutiste.
#
# -O2 et non -O3 : sur un interpreteur de processeur, -O3 allonge nettement la
# compilation sans gain mesurable au rendu.
RUN mkdir -p /build && cd /build \
 && emcc -O2 -c -std=gnu99 -I/src/psflib -I/src/he/Core -I/src/ht/Core \
      --use-port=zlib \
      /src/psflib/psflib.c /src/psflib/psf2fs.c \
 && echo "psflib compile"

# LA LISTE DES SOURCES VIENT DU FICHIER PROJET DE L'AMONT (Core/Core.pro), pas
# d'un balayage du dossier. Ces depots contiennent des fichiers qui ne sont PAS
# des unites de compilation : m68k/m68k_in.c est le gabarit que le generateur
# m68kmake transforme en m68kops.c, et le compiler donne des pages d'erreurs
# sur des identifiants faits de X majuscules. De meme pour les defines : ce
# sont ceux que l'amont declare, pas ceux qu'on devine.
RUN cd /build \
 && emcc -O2 -c -std=gnu99 -DEMU_COMPILE -DEMU_LITTLE_ENDIAN -DHAVE_STDINT_H \
      -I/src/he/Core --use-port=zlib \
      /src/he/Core/psx.c /src/he/Core/bios.c /src/he/Core/iop.c \
      /src/he/Core/ioptimer.c /src/he/Core/r3000.c /src/he/Core/spu.c \
      /src/he/Core/spucore.c /src/he/Core/vfs.c \
 && echo "Highly_Experimental compile"

# r3000asm.c et r3000dis.c sont laisses de cote, bien qu'ils figurent dans le
# fichier projet : ce sont l'assembleur et le desassembleur du R3000, outils de
# mise au point dont un lecteur n'a pas l'usage. Le premier ne compile
# d'ailleurs pas tel quel — il appelle tolower() sans inclure <ctype.h>, ce que
# clang refuse depuis C99. mkhebios.c est ecarte pour la meme raison d'usage :
# il fabrique un BIOS a partir d'une image PlayStation 2, et le PSF2 n'est pas
# du perimetre.

# yam.c, hors Windows, fait de __fastcall un __attribute__((regparm(3))) :
# une convention de passage d'arguments par registres propre au x86, que clang
# refuse ailleurs. Elle ne porte aucune semantique — seulement un choix d'ABI —
# et la retirer ne change donc rien au rendu. Le grep qui suit est la pour que
# ce correctif echoue bruyamment le jour ou l'amont reecrit cette ligne, au
# lieu de s'appliquer dans le vide.
RUN grep -q 'define __fastcall __attribute__((regparm(3)))' /src/ht/Core/yam.c \
 && sed -i 's/#define __fastcall __attribute__((regparm(3)))/#define __fastcall/' /src/ht/Core/yam.c \
 && echo "yam.c : regparm neutralise"

# USE_M68K et LSB_FIRST choisissent le coeur 68000 de MAME (Musashi) parmi les
# trois que le depot embarque — les deux autres, Starscream et c68k, ne sont
# alors pas compiles. HAVE_MPROTECT est volontairement omis : il n'ouvre la
# porte qu'a de la generation de code a l'execution, impossible en wasm.
RUN cd /build \
 && emcc -O2 -c -std=gnu99 -DEMU_COMPILE -DEMU_LITTLE_ENDIAN -DHAVE_STDINT_H \
      -DUSE_M68K -DLSB_FIRST \
      -I/src/ht/Core -I/src/ht/Core/m68k \
      /src/ht/Core/sega.c /src/ht/Core/dcsound.c /src/ht/Core/satsound.c \
      /src/ht/Core/yam.c /src/ht/Core/arm.c \
      /src/ht/Core/m68k/m68kops.c /src/ht/Core/m68k/m68kcpu.c \
 && echo "Highly_Theoretical compile"

# EXPORTED_FUNCTIONS n'est pas une liste de confort : tout ce qui n'y figure
# pas est elague par l'editeur de liens, et l'absence ne se verrait qu'a
# l'execution. Le garde-fou scripts/verify-wasm-abi.js relit cette liste depuis
# la colle produite et la confronte aux appels de src/.
RUN cd /build \
 && emcc -O2 -c -std=gnu99 -DEMU_COMPILE -DEMU_LITTLE_ENDIAN -I/src/psflib -I/src/he/Core -I/src/ht/Core /src/shim.c \
 && emcc -O2 *.o \
      --use-port=zlib \
      -o /tmp/psf.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'psf'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s FORCE_FILESYSTEM=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_psfx_open','_psfx_close','_psfx_render','_psfx_tags','_psfx_sample_rate','_psfx_type_of','_psfx_set_bios','_psfx_a_bios']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8','getValue','setValue','FS']"

FROM scratch AS artifacts
COPY --from=build /tmp/psf.js /psf.js
COPY --from=build /tmp/psf.wasm /psf.wasm
COPY --from=build /tmp/provenance.txt /psf-provenance.txt
