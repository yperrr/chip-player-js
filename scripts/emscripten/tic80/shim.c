// Facade du coeur TIC-80 pour le lecteur (src/players/Tic80Player.js).
//
// Le coeur s'utilise image par image : tic80_tick() fait tourner une image du
// programme (1/60 s), tic80_sound() en rend le son. On garde la meme cadence
// que le coeur libretro de TIC-80 : un tick, puis le son de cette image.
//
// L'HORLOGE
//
// time() et tstamp() d'une cartouche lisent l'horloge que l'hote fournit. Une
// demo se cale dessus. On lui donne une horloge VIRTUELLE, qui avance d'une
// image a chaque tick : le temps vu par la demo est exactement celui du son
// rendu — y compris quand une recherche fait tourner les images en accelere.
//
// Pas d'entrees : ni manette, ni clavier, ni souris. Une demo n'en a pas
// besoin ; un jeu reste sur son ecran-titre.

#include <stdint.h>
#include <string.h>
#include <emscripten.h>

#include "tic80.h"
#include "script.h"

#define FREQUENCE 1000000ULL

static tic80* tic = 0;
static char erreur[1024];
static int enErreur = 0;
static int sortie = 0;
static uint64_t images = 0;

static uint64_t compteur(void* data) { (void)data; return images * FREQUENCE / TIC80_FRAMERATE; }
static uint64_t frequence(void* data) { (void)data; return FREQUENCE; }

static void surTrace(const char* texte, u8 couleur) { (void)texte; (void)couleur; }

static void surErreur(const char* info)
{
    strncpy(erreur, info ? info : "erreur", sizeof erreur - 1);
    erreur[sizeof erreur - 1] = 0;
    enErreur = 1;
}

static void surSortie(void) { sortie = 1; }

// Cree le coeur a la cadence du contexte audio : TIC-80 synthetise a la
// cadence qu'on lui donne, il n'y a rien a reechantillonner.
EMSCRIPTEN_KEEPALIVE int t8_create(int cadence)
{
    if (tic) tic80_delete(tic);
    tic = tic80_create(cadence, TIC80_PIXEL_COLOR_RGBA8888);
    if (!tic) return -1;
    tic->callback.trace = surTrace;
    tic->callback.error = surErreur;
    tic->callback.exit = surSortie;
    return 0;
}

// 0 : chargee ; -1 : pas de coeur ; -3 : langage de la cartouche non compile
// ici (le message le nomme).
EMSCRIPTEN_KEEPALIVE int t8_load(const void* donnees, int taille)
{
    if (!tic) return -1;
    erreur[0] = 0; enErreur = 0; sortie = 0; images = 0;
    tic80_load(tic, (void*)donnees, taille);
    if (!tic_get_script((tic_mem*)tic)) {
        strncpy(erreur, "langage de script non pris en charge", sizeof erreur - 1);
        return -3;
    }
    return enErreur ? -2 : 0;
}

EMSCRIPTEN_KEEPALIVE const char* t8_error(void) { return erreur; }

// Une image : rend le nombre d'echantillons s16 (stereo entrelacee) prets dans
// t8_samples(), -1 si la cartouche a appele exit(), -2 sur une erreur de script.
EMSCRIPTEN_KEEPALIVE int t8_tick(void)
{
    if (!tic) return -1;
    if (enErreur) return -2;
    if (sortie) return -1;
    tic80_input entrees;
    memset(&entrees, 0, sizeof entrees);
    tic80_tick(tic, entrees, compteur, frequence);
    images++;
    tic80_sound(tic);
    if (enErreur) return -2;
    return tic->samples.count;
}

EMSCRIPTEN_KEEPALIVE const int16_t* t8_samples(void) { return tic ? tic->samples.buffer : 0; }

// L'ecran avec sa bordure : TIC80_FULLWIDTH x TIC80_FULLHEIGHT (256 x 144),
// RGBA. La couleur de bordure fait partie de l'image d'une demo.
EMSCRIPTEN_KEEPALIVE const uint32_t* t8_screen(void) { return tic ? tic->screen : 0; }

EMSCRIPTEN_KEEPALIVE void t8_close(void)
{
    if (tic) tic80_delete(tic);
    tic = 0;
}
