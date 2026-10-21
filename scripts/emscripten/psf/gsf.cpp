/*
 * Adaptateur C pour viogsf — le coeur Game Boy Advance des fichiers GSF.
 *
 * POURQUOI UN FICHIER A PART, ET EN C++
 *
 * Les trois coeurs deja embarques (PlayStation, Saturn, Dreamcast) exposent
 * une interface C, et shim.c les pilote directement. viogsf, lui, est du C++ :
 * son etat est une structure a constructeur, et surtout la sortie audio passe
 * par une CLASSE ABSTRAITE dont l'hote doit fournir une implementation —
 *
 *     struct GBASoundOut {
 *       virtual void write(const void *samples, unsigned long bytes) = 0;
 *     };
 *
 * On ne derive pas une classe virtuelle depuis du C. Plutot que de convertir
 * shim.c en C++ — et d'exposer tout le reste aux surprises de l'edition de
 * liens C++ —, ce fichier fait le pont : il implemente la classe, et n'offre
 * au-dehors que des fonctions « extern "C" ».
 *
 * CE QU'EST UN GSF
 *
 * Le meme conteneur PSF que les autres, octet de version 0x22. Le programme
 * qu'il transporte n'est ni un executable a televerser (PSF1) ni une
 * arborescence de fichiers (PSF2) : c'est un MORCEAU DE CARTOUCHE, decrit par
 * un en-tete de douze octets —
 *
 *     u32 point d'entree, u32 adresse de chargement, u32 longueur
 *
 * — suivi des octets a placer a cette adresse. Un rip se compose d'une
 * bibliotheque .gsflib, qui porte le moteur audio du jeu, et de .minigsf de
 * quelques centaines d'octets qui n'en changent que le numero de morceau. Les
 * segments se superposent dans l'ordre ou psflib les presente : la
 * bibliotheque d'abord, le morceau par-dessus.
 */
#include <new>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "GBA.h"
#include "Sound.h"

/* Espace cartouche de la Game Boy Advance : 32 Mo a partir de 0x08000000. */
#define GBA_ROM_BASE 0x08000000u
#define GBA_ROM_MAX  (32u * 1024u * 1024u)

/* Le coeur rend du 16 bits stereo a cette cadence, comme les autres. */
#define GSF_RATE 44100

namespace {

/*
 * Receptacle des echantillons.
 *
 * CPULoop() ne rend pas la main sur un nombre d'echantillons : il execute du
 * code, et le coeur appelle write() quand sa file est pleine. On accumule donc
 * dans une file a nous, et le rendu tourne jusqu'a en avoir assez.
 */
struct FileAudio : public GBASoundOut {
  int16_t *tampon;
  size_t capacite;   /* en int16_t */
  size_t remplis;

  FileAudio() : tampon(NULL), capacite(0), remplis(0) {}
  ~FileAudio() { free(tampon); }

  void write(const void *echantillons, unsigned long octets) {
    const size_t n = octets / sizeof(int16_t);
    if (n == 0) return;
    if (remplis + n > capacite) {
      size_t cap = capacite ? capacite : 8192;
      while (cap < remplis + n) cap *= 2;
      int16_t *n2 = (int16_t *)realloc(tampon, cap * sizeof(int16_t));
      if (!n2) return;        /* on perd ces echantillons plutot que la session */
      tampon = n2;
      capacite = cap;
    }
    memcpy(tampon + remplis, echantillons, n * sizeof(int16_t));
    remplis += n;
  }

  /* Retire au plus `demandes` int16_t et les recopie. */
  size_t prendre(int16_t *sortie, size_t demandes) {
    const size_t n = remplis < demandes ? remplis : demandes;
    if (n == 0) return 0;
    memcpy(sortie, tampon, n * sizeof(int16_t));
    memmove(tampon, tampon + n, (remplis - n) * sizeof(int16_t));
    remplis -= n;
    return n;
  }
};

struct Etat {
  GBASystem *gba;
  FileAudio file;
  uint8_t *rom;
  size_t rom_taille;
  uint32_t point_entree;
  int demarre;

  Etat() : gba(NULL), rom(NULL), rom_taille(0), point_entree(0), demarre(0) {}
};

uint32_t lire32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

}  /* namespace */

extern "C" {

void *gsfx_creer(void) {
  Etat *e = new (std::nothrow) Etat();
  if (!e) return NULL;
  e->gba = new (std::nothrow) GBASystem();
  if (!e->gba) { delete e; return NULL; }
  return e;
}

void gsfx_liberer(void *ctx) {
  Etat *e = (Etat *)ctx;
  if (!e) return;
  if (e->gba) {
    if (e->demarre) { soundShutdown(e->gba); CPUCleanUp(e->gba); }
    delete e->gba;
  }
  free(e->rom);
  delete e;
}

/*
 * Depose un segment GSF dans la cartouche.
 *
 * Appele une fois par fichier de la chaine, bibliotheque comprise. Les
 * segments se recouvrent : le dernier vu l'emporte, ce qui est exactement ce
 * qu'on veut — un .minigsf ne contient qu'un numero de morceau, pose par-dessus
 * la bibliotheque.
 *
 * Rend 0 si tout va bien.
 */
int gsfx_charger_segment(void *ctx, const uint8_t *exe, size_t taille) {
  Etat *e = (Etat *)ctx;
  if (!e || !exe || taille < 12) return -1;

  const uint32_t entree = lire32(exe + 0);
  const uint32_t adresse = lire32(exe + 4);
  const uint32_t longueur = lire32(exe + 8);
  if (longueur > taille - 12) return -2;

  /* L'adresse est donnee dans l'espace d'adressage de la console ; on ne garde
   * que le deplacement dans la cartouche. Un segment qui tomberait hors de
   * l'espace cartouche designe un fichier corrompu, pas une disposition
   * exotique : on refuse plutot que d'ecrire n'importe ou. */
  if (adresse < GBA_ROM_BASE) return -3;
  const uint32_t deplacement = adresse - GBA_ROM_BASE;
  if (deplacement > GBA_ROM_MAX || longueur > GBA_ROM_MAX - deplacement) return -4;

  const size_t besoin = (size_t)deplacement + longueur;
  if (besoin > e->rom_taille) {
    uint8_t *n = (uint8_t *)realloc(e->rom, besoin);
    if (!n) return -5;
    memset(n + e->rom_taille, 0, besoin - e->rom_taille);
    e->rom = n;
    e->rom_taille = besoin;
  }
  memcpy(e->rom + deplacement, exe + 12, longueur);

  /* Le point d'entree du PREMIER segment vu fait foi, comme pour le PSF1. */
  if (!e->point_entree) e->point_entree = entree;
  return 0;
}

/* Une fois tous les segments deposes : charge la cartouche et demarre. */
int gsfx_demarrer(void *ctx) {
  Etat *e = (Etat *)ctx;
  if (!e || !e->rom || e->rom_taille == 0) return -1;
  if (e->demarre) return 0;

  if (CPULoadRom(e->gba, e->rom, (uint32_t)e->rom_taille) == 0) return -2;
  if (!soundInit(e->gba, &e->file)) return -3;
  soundSetSampleRate(e->gba, GSF_RATE);
  CPUInit(e->gba);
  CPUReset(e->gba);
  soundReset(e->gba);
  e->demarre = 1;
  return 0;
}

/*
 * Rend au plus `trames` trames stereo. Retourne le nombre rendu, ou -1.
 *
 * CPULoop() execute du code jusqu'a ce que le coeur ait de quoi remplir sa
 * file ; rien ne garantit qu'un seul appel suffise. On boucle donc, avec un
 * plafond : un programme qui ne produirait jamais de son — rip incomplet,
 * morceau inexistant — ferait sinon tourner la page indefiniment.
 */
int gsfx_rendre(void *ctx, int16_t *sortie, int trames) {
  Etat *e = (Etat *)ctx;
  if (!e || !e->demarre || trames <= 0) return -1;
  const size_t voulus = (size_t)trames * 2;

  int tours = 0;
  while (e->file.remplis < voulus && tours < 64) {
    CPULoop(e->gba, 250000);
    tours++;
  }
  const size_t pris = e->file.prendre(sortie, voulus);
  return (int)(pris / 2);
}

int gsfx_cadence(void) { return GSF_RATE; }

}  /* extern "C" */
