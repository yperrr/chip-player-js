/*
 * Accesseurs sur la structure KSS, pour le lecteur.
 *
 * POURQUOI CE FICHIER
 *
 * Le lecteur a besoin de quelques champs de `KSS` : le titre, l'intervalle de
 * pistes reellement declare, les puces presentes. La facon habituelle de les
 * atteindre depuis JavaScript est de calculer les decalages de la structure a
 * la main et de lire le tas — c'est ce que fait VGMStreamPlayer, faute d'API.
 * Le prix en est connu : le jour ou l'amont ajoute un champ, les lectures
 * deviennent fausses SANS ERREUR, et l'on joue du bruit a un taux invente.
 *
 * Ici rien ne l'impose : quelques accesseurs compiles AVEC la bibliotheque
 * suivent la structure d'eux-memes. Un champ qui bouge, et c'est le C qui ne
 * compile plus — au bon moment, pas trois mois plus tard.
 */
#include "kss/kss.h"

int kssx_trk_min(KSS *k) { return k ? k->trk_min : 0; }
int kssx_trk_max(KSS *k) { return k ? k->trk_max : 0; }
const char *kssx_title(KSS *k) { return k ? (const char *)k->title : 0; }

/* 0 = MSX, 1 = Master System, 2 = Game Gear. */
int kssx_mode(KSS *k) { return k ? k->mode : 0; }
/* 0 = KSCC (en-tete classique), 1 = KSSX (en-tete etendu). */
int kssx_kssx(KSS *k) { return k ? k->kssx : 0; }

int kssx_fmpac(KSS *k) { return k ? k->fmpac : 0; }
int kssx_fmunit(KSS *k) { return k ? k->fmunit : 0; }
int kssx_msx_audio(KSS *k) { return k ? k->msx_audio : 0; }
int kssx_sn76489(KSS *k) { return k ? k->sn76489 : 0; }
int kssx_stereo(KSS *k) { return k ? k->stereo : 0; }

/* Le pilote sait-il dire qu'un morceau boucle, ou qu'il s'arrete ? */
int kssx_loop_detectable(KSS *k) { return k ? (int)k->loop_detectable : 0; }
int kssx_stop_detectable(KSS *k) { return k ? (int)k->stop_detectable : 0; }

/* Table des morceaux, quand le fichier en porte une (KSSX). */
int kssx_info_num(KSS *k) { return k ? k->info_num : 0; }
int kssx_info_song(KSS *k, int i) {
  return (k && k->info && i >= 0 && i < k->info_num) ? k->info[i].song : -1;
}
const char *kssx_info_title(KSS *k, int i) {
  return (k && k->info && i >= 0 && i < k->info_num) ? k->info[i].title : 0;
}
int kssx_info_time(KSS *k, int i) {
  return (k && k->info && i >= 0 && i < k->info_num) ? k->info[i].time_in_ms : -1;
}
