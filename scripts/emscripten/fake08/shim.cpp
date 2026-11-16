// Facade de FAKE-08 pour le lecteur : une poignee de fonctions C, pilotees
// depuis src/players/Pico8Player.js.
//
// FAKE-08 (MIT) est un emulateur de la console imaginaire PICO-8 : il execute
// le code Lua de la cartouche (z8lua), son synthetiseur et son ecran. On le
// pilote exactement comme son coeur libretro (platform/libretro/libretro.cpp)
// — un Step() par image a 60 Hz, 735 echantillons a 22 050 Hz toutes les deux
// images — en reprenant tel quel son hote libretro, qui n'est fait que de
// bouchons : pas de fenetre, pas de manette, pas de fichier a lister.
//
// L'ecran est rendu en RGBA 128 x 128, palette ecran appliquee, modes
// d'affichage (etirement, miroir, rotation) compris : c'est ce que le
// visualiseur « PICO-8 screen » dessine.

#include <cstdint>
#include <cstring>
#include <string>

#include "vm.h"
#include "Audio.h"
#include "PicoRam.h"
#include "host.h"
#include "hostVmShared.h"
#include "nibblehelpers.h"
#include "libretrohosthelpers.h"

static Host* hote = nullptr;
static PicoRam* memoire = nullptr;
static Audio* audio = nullptr;
static Vm* vm = nullptr;
static uint32_t couleurs[144];
static std::string derniereErreur;

extern "C" {

int f8_init() {
  if (vm) return 0;
  hote = new Host();
  memoire = new PicoRam();
  audio = new Audio(memoire);
  vm = new Vm(hote, memoire, nullptr, nullptr, audio);
  hote->setUpPaletteColors();
  Color* p = hote->GetPaletteColors();
  for (int i = 0; i < 144; i++) {
    // RGBA en memoire (ImageData) : octets R, G, B, A.
    couleurs[i] = (uint32_t)p[i].Red | ((uint32_t)p[i].Green << 8) | ((uint32_t)p[i].Blue << 16) | 0xff000000u;
  }
  hote->oneTimeSetup(audio);
  return 0;
}

// Charge une cartouche (.p8 texte ou .p8.png), directement : passer par la
// file de la VM demanderait un Step() sur une machine encore vide. Pas de
// repli sur le BIOS en cas d'echec — le menu de FAKE-08 n'a rien a faire dans
// un lecteur : on rend l'erreur.
//
// Les octets restent a la charge de l'appelant jusqu'au chargement suivant.
int f8_load(const uint8_t* donnees, int taille) {
  if (!vm) f8_init();
  setInputState(0, 0, 0, 0, 0);
  derniereErreur.clear();
  const bool ok = vm->LoadCart(donnees, (size_t)taille, false);
  // Charger ne lance pas : c'est vm_run() qui execute le Lua de la cartouche
  // (_init, puis la boucle _update/_draw), comme le fait la file de la VM.
  if (ok) vm->vm_run();
  derniereErreur = vm->GetBiosError();
  if (!ok && derniereErreur.empty()) derniereErreur = "cartouche illisible";
  return ok ? 0 : -1;
}

const char* f8_error() { return derniereErreur.c_str(); }

// Une image a 60 Hz. Pour une cartouche a 30 images/s, la VM ne met a jour
// qu'une fois sur deux : c'est elle qui decide, comme sous libretro.
//
// Rend 1 tant que la cartouche tourne, 0 si elle s'est arretee d'elle-meme,
// -2 sur une erreur Lua : la VM se rabattrait alors sur le menu du BIOS, on
// prefere s'arreter et dire pourquoi (f8_error).
int f8_step() {
  if (!vm) return -1;
  const bool encore = vm->Step();
  const std::string e = vm->GetBiosError();
  if (!e.empty()) { derniereErreur = e; return -2; }
  return encore ? 1 : 0;
}

int f8_fps() { return vm ? vm->getTargetFps() : 30; }

// `n` echantillons a 22 050 Hz, stereo 16 bits entrelace (gauche, droite).
void f8_audio(int16_t* sortie, int n) {
  if (!audio) { memset(sortie, 0, (size_t)n * 4); return; }
  audio->FillAudioBuffer(sortie, 0, (size_t)n);
}

// L'ecran, 128 x 128 RGBA, dans `sortie` (65 536 octets).
void f8_screen(uint32_t* sortie) {
  if (!vm) return;
  uint8_t* fb = vm->GetPicoInteralFb();
  uint8_t* pal = vm->GetScreenPaletteMap();
  const uint8_t mode = memoire->drawState.drawMode;
  for (int y = 0; y < 128; y++) {
    for (int x = 0; x < 128; x++) {
      int sx = x, sy = y;
      switch (mode) {
        case 1: sx = x / 2; break;                         // etire en largeur
        case 2: sy = y / 2; break;                         // etire en hauteur
        case 3: sx = x / 2; sy = y / 2; break;             // etire, les deux
        case 5: if (x >= 64) sx = 127 - x; break;          // miroir gauche -> droite
        case 6: if (y >= 64) sy = 127 - y; break;          // miroir haut -> bas
        case 7: if (x >= 64) sx = 127 - x; if (y >= 64) sy = 127 - y; break;
        case 129: sx = 127 - x; break;                     // retourne horizontalement
        case 130: sy = 127 - y; break;                     // retourne verticalement
        case 131: sx = 127 - x; sy = 127 - y; break;
        case 133: sx = y; sy = 127 - x; break;             // rotation 90
        case 134: sx = 127 - x; sy = 127 - y; break;       // rotation 180
        case 135: sx = 127 - y; sy = x; break;             // rotation 270
        default: break;
      }
      sortie[y * 128 + x] = couleurs[pal[getPixelNibble(sx, sy, fb)] & 0x8f];
    }
  }
}

void f8_close() {
  if (vm) vm->CloseCart();
}

}
