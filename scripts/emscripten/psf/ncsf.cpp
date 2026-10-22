/*
 * Adaptateur C pour SSEQPlayer — le lecteur NCSF (Nintendo DS).
 *
 * POURQUOI UN SECOND MOTEUR POUR LA MEME CONSOLE
 *
 * Le 2SF, pris en charge par ds.c, fait REJOUER LA CONSOLE : vio2sf emule les
 * deux processeurs ARM et laisse le moteur audio du jeu produire le son.
 *
 * Le NCSF procede a l'inverse. Il ne transporte aucun code. Sa section
 * programme est un SDAT — l'archive sonore de la console : sequences, banques
 * d'instruments, formes d'onde — et sa section reservee tient en quatre
 * octets, le numero de la sequence a jouer. SSEQPlayer interprete ces donnees
 * directement, sans rien emuler.
 *
 * Aucun des deux ne peut donc remplacer l'autre, et celui-ci est de tres loin
 * le plus leger. Un rip se compose d'un .ncsflib portant le SDAT entier et de
 * .minincsf d'une centaine d'octets qui n'en designent qu'une sequence.
 *
 * Le pont est en C++ parce que SSEQPlayer l'est : SDAT et Player sont des
 * classes, et GenerateSamples() ecrit dans un std::vector.
 *
 * LES EXCEPTIONS SONT ICI UNE NECESSITE, PAS UN CONFORT
 *
 * SSEQPlayer n'a pas d'autre canal d'erreur : chaque structure malformee leve
 * une std::runtime_error (FATSection, INFOSection, SBNK, SSEQ, SWAR, SYMB...).
 * Sans capture possible, un seul fichier douteux ferait avorter le module
 * ENTIER — donc toute lecture, tous formats confondus, jusqu'au rechargement
 * de la page. C'est pourquoi le Dockerfile compile et lie cette partie avec
 * -fexceptions, et pourquoi chaque entree publique ci-dessous est gardee.
 */
#include <cstdint>
#include <cstring>
#include <memory>
#include <new>
#include <vector>

#include "SDAT.h"
#include "Player.h"

namespace {

struct Etat {
  std::vector<uint8_t> sdat;     /* accumule au fil de la chaine _lib */
  uint32_t sseq;                 /* pose par la section reservee du .minincsf */
  std::unique_ptr<SDAT> archive;
  Player lecteur;
  std::vector<uint8_t> tampon;   /* GenerateSamples ecrit dans un vector */

  Etat() : sseq(0) {}
};

uint32_t lire32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
         ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

}  /* namespace */

extern "C" {

void *ncsfx_creer(void) {
  return new (std::nothrow) Etat();
}

void ncsfx_liberer(void *h) {
  Etat *e = (Etat *)h;
  if (!e) return;
  try { e->lecteur.Stop(true); } catch (...) { }
  delete e;
}

/*
 * Un maillon de la chaine. psflib appelle ce rappel une fois par fichier,
 * bibliotheque d'abord : le .ncsflib apporte le SDAT par sa section programme,
 * le .minincsf n'apporte que le numero de sequence par sa section reservee.
 */
int ncsfx_charger(void *h, const uint8_t *exe, size_t exe_size,
                  const uint8_t *resv, size_t resv_size) {
  Etat *e = (Etat *)h;
  if (!e) return -1;

  if (resv && resv_size >= 4) e->sseq = lire32(resv);

  if (exe && exe_size >= 12) {
    /* L'en-tete du SDAT porte sa propre taille en octets 8 a 11. On s'y fie
     * plutot qu'a la taille du segment, sans jamais la depasser. */
    uint32_t taille = lire32(exe + 8);
    if (taille > exe_size) return -1;
    if (e->sdat.size() < taille) e->sdat.resize(taille, 0);
    memcpy(&e->sdat[0], exe, taille);
  }
  return 0;
}

int ncsfx_demarrer(void *h, int cadence) {
  Etat *e = (Etat *)h;
  if (!e || e->sdat.empty() || cadence <= 0) return -1;
  try {
    PseudoFile f;
    f.data = &e->sdat;
    e->archive.reset(new SDAT(f, e->sseq));
    SSEQ *seq = e->archive->sseq.get();
    if (!seq) return -2;
    e->lecteur.sseqVol = Cnv_Scale(seq->info.vol);
    e->lecteur.sampleRate = cadence;
    e->lecteur.interpolation = INTERPOLATION_SINC;
    e->lecteur.Setup(seq);
    e->lecteur.Timer();
  } catch (...) {
    return -3;
  }
  return 0;
}

/* Trames stereo 16 bits, a la cadence passee a ncsfx_demarrer. */
int ncsfx_rendre(void *h, int16_t *sortie, int trames) {
  Etat *e = (Etat *)h;
  if (!e || !sortie || trames <= 0 || !e->archive) return -1;
  size_t octets = (size_t)trames * 4;
  unsigned n = (unsigned)trames;
  try {
    if (e->tampon.size() < octets) e->tampon.resize(octets);
    e->lecteur.GenerateSamples(e->tampon, 0, n);
  } catch (...) {
    return -1;
  }
  memcpy(sortie, &e->tampon[0], (size_t)n * 4);
  return (int)n;
}

}  /* extern "C" */
