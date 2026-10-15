# Image d'artefacts du fork chiplayer.
#
# Elle ne tourne pas : c'est un porte-fichiers, publie sur ghcr.io et consomme
# par la stack GitLab avec `COPY --from=`. Son role tient en une phrase :
# garantir que le frontend construit et les sources serveur viennent du MEME
# commit.
#
# Pourquoi cela compte : la stack tirait jusqu'ici deux archives distinctes de
# l'amont, un frontend precompile (branche gh-pages, juin) et un backend
# (master, fin juin). Mesure a l'appui, ce decalage casse — le gabarit de la
# page porte des marqueurs __NOSCRIPT_CONTENT__ et __SCHEMA_JSON_LD__ que seul
# un serveur assez recent sait remplacer. Sinon ils restent litteralement dans
# la page, React ne monte jamais, et l'application reste blanche sans un mot
# d'explication.
#
# La separation des roles est volontaire : ici on ne construit QUE le lecteur.
# Le serveur applicatif, l'administration, les gardes de catalogue et les
# playlists restent dans le depot GitLab, qui assemble l'image finale.

# ---- Construction du lecteur ----
FROM node:24-slim AS build
WORKDIR /build

# Couche isolee : tant que le verrou de dependances ne bouge pas, cette etape
# est reprise du cache et ne coute rien.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .

# Chemins relatifs par defaut : le lecteur est servi par le meme hote que son
# API et son catalogue. Surchargeables si un jour ce n'est plus le cas.
ARG REACT_APP_API_BASE=/api
ARG REACT_APP_CATALOG_PREFIX=/catalog
ARG REACT_APP_SOUNDFONT_URL_PATH=/soundfonts
ENV REACT_APP_API_BASE=$REACT_APP_API_BASE \
    REACT_APP_CATALOG_PREFIX=$REACT_APP_CATALOG_PREFIX \
    REACT_APP_SOUNDFONT_URL_PATH=$REACT_APP_SOUNDFONT_URL_PATH \
    GENERATE_SOURCEMAP=false

# Le garde-fou passe AVANT webpack : il verifie que le coeur wasm vendorise
# exporte tout ce que le code appelle. Un symbole manquant ne se verrait pas a
# la construction, seulement a l'execution, sur un format particulier.
RUN node scripts/verify-chip-core-abi.js && npm run build-lite

# ---- Artefacts ----
# `scratch` : rien d'executable, que des fichiers a recopier.
FROM scratch AS artifacts
COPY --from=build /build/build /frontend
COPY --from=build /build/server /server
COPY --from=build /build/scripts /scripts
COPY --from=build /build/src/config /src/config
