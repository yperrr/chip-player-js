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
ARG VIOGSF_COMMIT=6c43a9926a6a85fbb736ea8f5f7f6c4f59ed3d64
ARG VIO2SF_COMMIT=cbad66408b72d3bdc9f6c5ba724fe3e17f996865
ARG SSEQ_COMMIT=77222d3657adff358fb4e610d3e56bb7ada8ec24

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/kode54/psflib.git psflib \
 && git clone https://github.com/kode54/Highly_Experimental.git he \
 && git clone https://github.com/kode54/Highly_Theoretical.git ht \
 && git clone https://github.com/kode54/viogsf.git viogsf \
 && git clone -b splayer-mod https://github.com/RGBA-CRT/vio2sf-fork.git vio2sf \
 && git clone https://github.com/kode54/SSEQPlayer.git sseq \
 && git -C psflib checkout "$PSFLIB_COMMIT" \
 && git -C he checkout "$HE_COMMIT" \
 && git -C ht checkout "$HT_COMMIT" \
 && git -C viogsf checkout "$VIOGSF_COMMIT" \
 && git -C vio2sf checkout "$VIO2SF_COMMIT" \
 && git -C sseq checkout "$SSEQ_COMMIT" \
 && for d in psflib he ht viogsf vio2sf sseq; do \
      printf '%-10s %s\n' "$d" "$(git -C $d rev-parse HEAD)"; \
    done | tee /tmp/provenance.txt

COPY shim.c /src/shim.c
COPY gsf.cpp /src/gsf.cpp
COPY ds.c /src/ds.c
COPY wincompat.h /src/compat/wincompat.h
COPY ncsf.cpp /src/ncsf.cpp

# regparm EST UN ATTRIBUT x86, et GBAcpu.h ne le conditionne qu'a __GNUC__ —
# que clang satisfait. Sur wasm, chaque fonction ainsi decoree fait echouer la
# compilation. On retire l'attribut, ce qui revient exactement a la branche
# non-GNU de ce meme en-tete.
#
# La substitution est ENCADREE : on verifie qu'il y avait bien quelque chose a
# changer, puis qu'il ne reste rien. Un sed muet qui ne trouve plus son motif
# laisserait passer une recette silencieusement cassee le jour ou l'amont
# renomme la macro.
RUN grep -q 'regparm(2)' /src/viogsf/vbam/gba/GBAcpu.h \
 && sed -i 's/__attribute__((regparm(2)))//' /src/viogsf/vbam/gba/GBAcpu.h \
 && ! grep -q 'regparm' /src/viogsf/vbam/gba/GBAcpu.h \
 && echo "viogsf : attribut regparm neutralise"

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
      /src/he/Core/spucore.c /src/he/Core/vfs.c /src/he/Core/mkhebios.c \
 && echo "Highly_Experimental compile"

# r3000asm.c et r3000dis.c sont laisses de cote, bien qu'ils figurent dans le
# fichier projet : ce sont l'assembleur et le desassembleur du R3000, outils de
# mise au point dont un lecteur n'a pas l'usage. Le premier ne compile
# d'ailleurs pas tel quel — il appelle tolower() sans inclure <ctype.h>, ce que
# clang refuse depuis C99.
#
# mkhebios.c, EN REVANCHE, est bien compile. Ce n'est pas un outil annexe : il
# fabrique, a partir d'un BIOS de PlayStation 2, la seule forme d'image que le
# coeur accepte — celle qui porte la banniere « Highly Experimental » et les
# variables de preamorçage. Sans lui, l'utilisateur devrait produire ce fichier
# a la main avec un outil tiers ; avec lui, il depose sa ROM et la pile s'en
# charge.

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

# viogsf — le coeur Game Boy Advance, derive de VBA-M. C'est du C++, seul de
# son espece ici : sa sortie audio est une classe abstraite dont l'hote fournit
# l'implementation, ce qu'on ne fait pas depuis du C. gsf.cpp porte cette
# implementation et n'expose au-dehors que des fonctions « extern "C" », que le
# shim appelle comme les autres coeurs.
#
# La liste des sources vient de viogsf.pro, comme les autres viennent de leur
# propre fichier projet.
# DANS SON PROPRE DOSSIER. viogsf a un bios.cpp, Highly_Experimental un
# bios.c : compiles cote a cote, le second objet ecrase le premier et l'edition
# de liens reclame des symboles de BIOS PlayStation introuvables — une erreur
# qui ne dit rien de sa cause. Un dossier par coeur supprime la question.
RUN mkdir -p /build/gba && cd /build/gba \
 && em++ -O2 -c -std=gnu++11 \
      -I/src/viogsf/vbam -I/src/viogsf/vbam/common \
      -I/src/viogsf/vbam/gba -I/src/viogsf/vbam/apu \
      /src/viogsf/vbam/apu/Multi_Buffer.cpp \
      /src/viogsf/vbam/apu/Gb_Oscs.cpp \
      /src/viogsf/vbam/apu/Gb_Apu.cpp \
      /src/viogsf/vbam/apu/Effects_Buffer.cpp \
      /src/viogsf/vbam/apu/Blip_Buffer.cpp \
      /src/viogsf/vbam/gba/Sound.cpp \
      /src/viogsf/vbam/gba/GBA.cpp \
      /src/viogsf/vbam/gba/GBA-thumb.cpp \
      /src/viogsf/vbam/gba/GBA-arm.cpp \
      /src/viogsf/vbam/gba/bios.cpp \
      /src/gsf.cpp \
 && echo "viogsf compile"

# vio2sf - le coeur Nintendo DS, derive de DeSmuME. Deux processeurs ARM
# emules : de loin le plus lourd de ce module.
#
# DANS SON PROPRE DOSSIER, pour la raison deja rencontree avec viogsf : ce
# coeur a un bios.c, Highly_Experimental aussi, et le second objet ecraserait
# le premier en silence.
#
# Le coeur compile sans aucune retouche, ce qui est rare. Seul le pilote
# reclame un geste, explique plus bas.
RUN mkdir -p /build/ds && cd /build/ds \
 && emcc -O2 -c -std=gnu99 -fomit-frame-pointer \
      -I/src/vio2sf/src/vio2sf -I/src/vio2sf/src/vio2sf/desmume \
      --use-port=zlib \
      /src/vio2sf/src/vio2sf/desmume/armcpu.c \
      /src/vio2sf/src/vio2sf/desmume/arm_instructions.c \
      /src/vio2sf/src/vio2sf/desmume/barray.c \
      /src/vio2sf/src/vio2sf/desmume/bios.c \
      /src/vio2sf/src/vio2sf/desmume/cp15.c \
      /src/vio2sf/src/vio2sf/desmume/FIFO.c \
      /src/vio2sf/src/vio2sf/desmume/GPU.c \
      /src/vio2sf/src/vio2sf/desmume/isqrt.c \
      /src/vio2sf/src/vio2sf/desmume/matrix.c \
      /src/vio2sf/src/vio2sf/desmume/mc.c \
      /src/vio2sf/src/vio2sf/desmume/MMU.c \
      /src/vio2sf/src/vio2sf/desmume/NDSSystem.c \
      /src/vio2sf/src/vio2sf/desmume/resampler.c \
      /src/vio2sf/src/vio2sf/desmume/state.c \
      /src/vio2sf/src/vio2sf/desmume/thumb_instructions.c \
 && em++ -O2 -c -std=gnu++11 -fno-rtti -fno-exceptions \
      -I/src/vio2sf/src/vio2sf -I/src/vio2sf/src/vio2sf/desmume \
      /src/vio2sf/src/vio2sf/desmume/SPU.cpp \
 && echo "vio2sf : coeur DS compile"

# windows.h, dans drvimpl.c, ne sert qu'a des typedefs et aux trois appels de
# trace de dlog(). wincompat.h les fournit.
#
# Pourquoi ce detour est necessaire et non cosmetique : le xsfc.h de vio2sf
# est entierement enferme dans un #ifdef __cplusplus, donc VIDE en C.
# tagget.h, qui l'inclut, compte malgre tout sur DWORD, BYTE et _strnicmp :
# c'etait windows.h, inclus avant lui, qui les apportait.
#
# Le grep encadre le sed. Si l'amont retire cette ligne, la construction
# s'arrete ici plutot que de compiler un pilote qu'on croirait adapte.
RUN grep -q "^#include <windows.h>" /src/vio2sf/src/plugins/vio2sf/drvimpl.c \
 && sed -i 's|^#include <windows.h>|#include "wincompat.h"|' \
      /src/vio2sf/src/plugins/vio2sf/drvimpl.c \
 && cd /build/ds \
 && emcc -O2 -c -std=gnu99 -fomit-frame-pointer \
      -I/src/compat \
      -I/src/vio2sf/src/vio2sf -I/src/vio2sf/src/vio2sf/desmume \
      -I/src/vio2sf/src/plugins/xsfc -I/src/vio2sf/src/plugins/vio2sf \
      --use-port=zlib \
      /src/vio2sf/src/plugins/vio2sf/drvimpl.c \
 && emcc -O2 -c -std=gnu99 /src/ds.c \
 && echo "vio2sf : pilote 2SF compile"

# SSEQPlayer - le lecteur NCSF. Pas un emulateur : il interprete le SDAT de
# la console directement. Il compile sans la moindre retouche, et pese une
# fraction du coeur DS.
#
# -fexceptions N EST PAS FACULTATIF ICI. SSEQPlayer n a pas d autre canal
# d erreur que std::runtime_error, levee par chaque structure malformee.
# Sans capture possible, un seul fichier douteux ferait avorter le module
# ENTIER - donc toute lecture, tous formats confondus. Voir ncsf.cpp.
#
# Dossier separe, comme les autres coeurs : SDAT.cpp et consorts portent des
# noms trop communs pour cohabiter avec le reste dans /build.
RUN mkdir -p /build/ncsf && cd /build/ncsf \
 && em++ -O2 -c -std=c++17 -w -fexceptions -I/src/sseq /src/sseq/*.cpp \
 && em++ -O2 -c -std=c++17 -w -fexceptions -I/src/sseq /src/ncsf.cpp \
 && echo "SSEQPlayer : lecteur NCSF compile"

# EXPORTED_FUNCTIONS n'est pas une liste de confort : tout ce qui n'y figure
# pas est elague par l'editeur de liens, et l'absence ne se verrait qu'a
# l'execution. Le garde-fou scripts/verify-wasm-abi.js relit cette liste depuis
# la colle produite et la confronte aux appels de src/.
RUN cd /build \
 && emcc -O2 -c -std=gnu99 -DEMU_COMPILE -DEMU_LITTLE_ENDIAN -I/src/psflib -I/src/he/Core -I/src/ht/Core /src/shim.c \
 && em++ -O2 -fexceptions *.o gba/*.o ds/*.o ncsf/*.o \
      --use-port=zlib \
      -o /tmp/psf.js \
      -s WASM=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME="'psf'" \
      -s ENVIRONMENT=web \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s FORCE_FILESYSTEM=1 \
      -s EXPORTED_FUNCTIONS="['_malloc','_free','_psfx_open','_psfx_close','_psfx_render','_psfx_tags','_psfx_sample_rate','_psfx_type_of','_psfx_set_bios','_psfx_set_bios_ps2','_psfx_a_bios']" \
      -s EXPORTED_RUNTIME_METHODS="['HEAP8','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','UTF8ToString','stringToUTF8','lengthBytesUTF8','getValue','setValue','FS']"

FROM scratch AS artifacts
COPY --from=build /tmp/psf.js /psf.js
COPY --from=build /tmp/psf.wasm /psf.wasm
COPY --from=build /tmp/provenance.txt /psf-provenance.txt
