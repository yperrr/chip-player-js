/*
 * Façade plate au-dessus de psflib et des deux cœurs d'émulation.
 *
 * POURQUOI CE FICHIER
 *
 * psflib ne se pilote que par rappels : on lui passe des pointeurs de fonction
 * pour ouvrir les fichiers, pour recevoir le programme décompressé, pour
 * recevoir chaque étiquette. Depuis JavaScript il faudrait fabriquer ces
 * pointeurs avec addFunction(), c'est-à-dire exposer la table des fonctions du
 * wasm et faire traverser la frontière à chaque octet lu d'un fichier.
 *
 * Ces rappels sont donc écrits ici, en C, et le JavaScript ne voit qu'une
 * poignée de fonctions ordinaires. Même raison que pour scripts/emscripten/
 * libkss/shim.c, et même bénéfice : aucun décalage de structure calculé à la
 * main, rien à resynchroniser quand l'amont bouge.
 *
 * CE QUE PSFLIB FAIT POUR NOUS
 *
 * Un .psf, un .ssf ou un .dsf est le même conteneur — seul l'octet de version
 * change (0x01 PlayStation, 0x11 Saturn, 0x12 Dreamcast). Son en-tête porte un
 * programme compressé en zlib, et ses étiquettes peuvent renvoyer à des
 * fichiers voisins par _lib, _lib2, _lib3… qui sont eux-mêmes des conteneurs
 * PSF, récursivement. psf_load() démêle tout cela et appelle notre rappel de
 * chargement dans le BON ORDRE : la bibliothèque d'abord, le morceau par-dessus.
 * C'est tout l'intérêt de ne pas réécrire ce format à la main.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "psflib.h"
#include "psx.h"
#include "bios.h"
#include "mkhebios.h"
#include "sega.h"

#define PSFX_PSF1 0x01
#define PSFX_SSF  0x11
#define PSFX_DSF  0x12

/* Les deux cœurs rendent du 16 bits stéréo à cette cadence, sans réglage. */
#define PSFX_RATE 44100

typedef struct {
  uint8_t type;
  void *state;       /* état du cœur, alloué selon sa taille annoncée */
  uint8_t *prog;     /* programme accumulé, pour Saturn et Dreamcast */
  size_t prog_size;
  char *tags;        /* « nom=valeur\n » concaténés */
  size_t tags_len, tags_cap;
  int ouvert;
} psfx_t;

static psfx_t G;
static int psx_pret = 0, sega_pret = 0;

/* ------------------------------------------------------------------ E/S */

/* psflib ouvre les fichiers par chemin : ceux-ci sont déposés dans le système
 * de fichiers d'emscripten par le lecteur, avant l'appel. Le stdio ordinaire
 * suffit donc, et c'est bien le but. */
static void *cb_fopen(void *ctx, const char *path) {
  (void)ctx;
  return fopen(path, "rb");
}
static size_t cb_fread(void *buffer, size_t size, size_t count, void *handle) {
  return fread(buffer, size, count, (FILE *)handle);
}
static int cb_fseek(void *handle, int64_t offset, int whence) {
  return fseek((FILE *)handle, (long)offset, whence);
}
static int cb_fclose(void *handle) { return fclose((FILE *)handle); }
static long cb_ftell(void *handle) { return ftell((FILE *)handle); }

static const psf_file_callbacks CB = {
  "/",            /* séparateurs de chemin */
  NULL,           /* contexte de fopen */
  cb_fopen, cb_fread, cb_fseek, cb_fclose, cb_ftell
};

/* -------------------------------------------------------------- étiquettes */

static int cb_info(void *ctx, const char *nom, const char *valeur) {
  (void)ctx;
  size_t besoin = strlen(nom) + strlen(valeur) + 2;
  if (G.tags_len + besoin + 1 > G.tags_cap) {
    size_t cap = G.tags_cap ? G.tags_cap * 2 : 1024;
    while (cap < G.tags_len + besoin + 1) cap *= 2;
    char *n = realloc(G.tags, cap);
    if (!n) return -1;
    G.tags = n;
    G.tags_cap = cap;
  }
  G.tags_len += (size_t)sprintf(G.tags + G.tags_len, "%s=%s\n", nom, valeur);
  return 0;
}

/* ---------------------------------------------------------- chargement PS1 */

static int cb_load_psf1(void *ctx, const uint8_t *exe, size_t exe_size,
                        const uint8_t *reserved, size_t reserved_size) {
  (void)ctx; (void)reserved; (void)reserved_size;
  if (exe_size < 0x800) return -1;
  /* Chaque maillon de la chaîne _lib est un PS-X EXE complet, avec sa propre
   * adresse de chargement : le cœur les empile lui-même, dans l'ordre où
   * psflib nous les donne. */
  return psx_upload_psxexe(G.state, (void *)exe, (uint32_t)exe_size);
}

/* ------------------------------------------------- chargement Saturn / DC */

static uint32_t lire32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void ecrire32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

/*
 * Saturn et Dreamcast ne s'empilent pas comme la PlayStation.
 *
 * Leur section de programme est un bloc nu precede d'une adresse de
 * chargement sur quatre octets. Un maillon de la chaine ne remplace donc pas
 * le precedent : il se superpose A SON OFFSET. On tient l'union des deux
 * intervalles, le plus recent ecrasant le plus ancien la ou ils se recouvrent
 * — c'est la regle du format, et c'est ce qui fait qu'un .ssf de quelques
 * centaines d'octets joue vraiment, en se posant sur la .ssflib du jeu.
 */
static int cb_load_sdsf(void *ctx, const uint8_t *exe, size_t exe_size,
                        const uint8_t *reserved, size_t reserved_size) {
  (void)ctx; (void)reserved; (void)reserved_size;
  if (exe_size < 4) return -1;

  if (G.prog_size < 4) {
    uint8_t *d = malloc(exe_size);
    if (!d) return -1;
    memcpy(d, exe, exe_size);
    G.prog = d;
    G.prog_size = exe_size;
    return 0;
  }

  uint32_t debut_dst = lire32(G.prog), debut_src = lire32(exe);
  uint32_t len_dst = (uint32_t)(G.prog_size - 4), len_src = (uint32_t)(exe_size - 4);
  uint32_t debut = debut_dst < debut_src ? debut_dst : debut_src;
  uint32_t fin_dst = debut_dst + len_dst, fin_src = debut_src + len_src;
  uint32_t fin = fin_dst > fin_src ? fin_dst : fin_src;

  size_t taille = (size_t)(fin - debut) + 4;
  uint8_t *n = calloc(1, taille);
  if (!n) return -1;
  ecrire32(n, debut);
  memcpy(n + 4 + (debut_dst - debut), G.prog + 4, len_dst);
  memcpy(n + 4 + (debut_src - debut), exe + 4, len_src);
  free(G.prog);
  G.prog = n;
  G.prog_size = taille;
  return 0;
}

/* ------------------------------------------------------------------ API */

void psfx_close(void) {
  free(G.state); G.state = NULL;
  free(G.prog); G.prog = NULL; G.prog_size = 0;
  free(G.tags); G.tags = NULL; G.tags_len = G.tags_cap = 0;
  G.ouvert = 0;
  G.type = 0;
}

/*
 * Ouvre un morceau deja depose dans le systeme de fichiers, avec ses
 * bibliotheques voisines. Rend 0 si tout va bien.
 */
int psfx_open(const char *chemin, int type) {
  psfx_close();
  G.type = (uint8_t)type;

  if (type == PSFX_PSF1) {
    /*
     * Le coeur PlayStation EXIGE une image de BIOS Sony, et son auteur ne s'en
     * cache pas : « The unfortunate dirty secret here is that Sony BIOS is
     * used » (Core/Readme.txt). Il n'en embarque aucune — bios.c declare un
     * pointeur nul —, elle doit venir de l'exterieur par bios_set_image().
     *
     * Le piege est que psx_init() REND ZERO, c'est-a-dire le code de SUCCES,
     * quand le BIOS manque :
     *
     *     // BIOS must be loaded first
     *     if ( !bios_get_image_native() || !bios_get_imagesize() ) return 0;
     *
     * Rien n'est alors initialise, psx_get_state_size() rend n'importe quoi,
     * et le R3000 part executer de la memoire vide : l'onglet se fige, sans
     * message. On verifie donc le BIOS NOUS-MEMES, avant d'appeler quoi que ce
     * soit, et on rend une erreur franche.
     */
    if (!bios_get_image_native() || !bios_get_imagesize()) return -10;
    if (!psx_pret) { if (psx_init() != 0) return -1; psx_pret = 1; }
    uint32_t taille = psx_get_state_size(1);
    if (taille == 0 || taille > (64u << 20)) return -11;
    G.state = calloc(1, taille);
    if (!G.state) return -2;
    psx_clear_state(G.state, 1);
  } else if (type == PSFX_SSF || type == PSFX_DSF) {
    if (!sega_pret) { if (sega_init() != 0) return -1; sega_pret = 1; }
    uint8_t v = (type == PSFX_SSF) ? 1 : 2;   /* 1 = Saturn, 2 = Dreamcast */
    G.state = calloc(1, sega_get_state_size(v));
    if (!G.state) return -2;
    sega_clear_state(G.state, v);
  } else {
    return -3;
  }

  int r = psf_load(chemin, &CB, (uint8_t)type,
                   (type == PSFX_PSF1) ? cb_load_psf1 : cb_load_sdsf, NULL,
                   cb_info, NULL, 0, NULL, NULL);
  if (r < 0) { psfx_close(); return -4; }

  if (type != PSFX_PSF1) {
    if (G.prog_size < 4) { psfx_close(); return -5; }
    if (sega_upload_program(G.state, G.prog, (uint32_t)G.prog_size) != 0) {
      psfx_close();
      return -6;
    }
  }

  G.ouvert = 1;
  return 0;
}

/*
 * Rend au plus `demandes` trames stereo. Retourne le nombre reellement rendu,
 * qui peut etre inferieur — zero compris — ou -1 sur erreur irrecuperable.
 *
 * Le nombre de cycles passe est volontairement enorme : les deux coeurs
 * s'arretent au premier des deux plafonds, et c'est le compte d'echantillons
 * qui doit commander.
 */
int psfx_render(int16_t *buf, int demandes) {
  if (!G.ouvert || demandes <= 0) return -1;
  uint32_t n = (uint32_t)demandes;
  int32_t r;
  if (G.type == PSFX_PSF1) {
    r = psx_execute(G.state, 0x7fffffff, buf, &n, 0);
    if (r < -1) return -1;
  } else {
    r = sega_execute(G.state, 0x7fffffff, buf, &n);
    if (r < 0) return -1;
  }
  return (int)n;
}

const char *psfx_tags(void) { return G.tags ? G.tags : ""; }

/*
 * Fournit l'image de BIOS que reclame le coeur PlayStation.
 *
 * Elle n'est pas, et ne sera pas, embarquee : c'est du code sous droits de
 * Sony. Cette porte existe pour qu'un utilisateur puisse donner la sienne,
 * celle de sa propre console. Tant qu'elle n'est pas appelee, psfx_open rend
 * -10 pour un .psf et le lecteur le dit clairement.
 *
 * Le coeur CONSERVE LE POINTEUR tel quel — il ne recopie rien. Le tampon doit
 * donc rester valide tant que la bibliotheque s'en sert, c'est-a-dire toute la
 * session. (L'inversion d'octets que fait bios_set_image est, elle, sous
 * #ifdef EMU_BIG_ENDIAN : elle n'a pas lieu ici.)
 */
void psfx_set_bios(uint8_t *image, int taille) {
  if (image && taille > 0) bios_set_image(image, (uint32_t)taille);
}

int psfx_a_bios(void) { return bios_get_image_native() && bios_get_imagesize() ? 1 : 0; }

/*
 * Fabrique l'image HE a partir d'un BIOS de PlayStation 2, et l'installe.
 *
 * C'est la voie praticable pour l'utilisateur ordinaire : le coeur n'accepte
 * que des images portant la banniere « Highly Experimental » et ses variables
 * de preamorçage, qui ne se trouvent dans aucune ROM de console. mkhebios les
 * fabrique — il depouille le BIOS PS2 module par module pour n'en garder que
 * ce qui sert au son, PlayStation 1 comprise, applique deux correctifs et
 * ecrit la zone de configuration a l'offset 0x80.
 *
 * Entree : exactement 4 Mo. Sortie : 512 Ko. Rend la taille produite, ou -1.
 *
 * Le tampon rendu par mkhebios n'est PAS libere : bios_set_image en conserve
 * le pointeur pour toute la session.
 */
int psfx_set_bios_ps2(uint8_t *ps2, int taille) {
  int n = taille;
  void *image = mkhebios_create(ps2, &n);
  if (!image) return -1;
  bios_set_image((uint8_t *)image, (uint32_t)n);
  return n;
}

int psfx_sample_rate(void) { return PSFX_RATE; }

/* Reconnait le type a partir des quatre premiers octets, sans rien ouvrir. */
int psfx_type_of(const uint8_t *entete, int taille) {
  if (taille < 4) return 0;
  if (entete[0] != 'P' || entete[1] != 'S' || entete[2] != 'F') return 0;
  return entete[3];
}
