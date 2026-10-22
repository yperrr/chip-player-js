/*
 * 2SF (Nintendo DS) : liaison entre le shim et le pilote vio2sf.
 *
 * Ce format se distingue des autres de la famille sur un point qui commande
 * toute l'organisation de ce fichier : vio2sf fait LUI-MEME l'analyse du
 * conteneur et la resolution de la chaine _lib, par son propre code
 * (drvimpl.c, au-dessus de tagget.h). On ne lui passe donc pas des segments
 * decoupes par psflib, comme pour le GSF ou le SSF, mais le fichier brut.
 *
 * Il reclame en retour ses bibliotheques par xsf_get_lib(), un rappel que
 * l'hote doit fournir — c'est tout l'objet de ce fichier. On le sert depuis le
 * systeme de fichiers d'emscripten, ou PSFPlayer._deposerAvecLibs a deja
 * depose la chaine complete a cote du morceau : le pilote croit lire un
 * disque, il lit en realite ce que le navigateur a telecharge.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* Fournis par drvimpl.c. Redeclares ici plutot qu'inclus : le drvimpl.h de
 * vio2sf traine un wchar_t dans xsf_set_extend_param, dont nous n'avons que
 * faire, et le reste de l'en-tete ne porte que ces trois symboles. */
int  xsf_start(void *pfile, unsigned bytes);
int  xsf_gen(void *pbuffer, unsigned samples);
void xsf_term(void);

/* Declare extern par drvimpl.h, jamais definie par le pilote : sans cette
 * ligne le lien echoue. Le shim n'expose pas encore le masquage de canaux. */
unsigned long dwChannelMute = 0;

/* Dossier ou chercher les .2sflib, pose par ds2sf_dossier() avant l'ouverture. */
static char g_dossier[1024] = "";

void ds2sf_dossier(const char *chemin) {
  snprintf(g_dossier, sizeof g_dossier, "%s", chemin ? chemin : "");
}

/*
 * Rappel reclame par vio2sf : rend le contenu d'une bibliotheque nommee dans
 * une etiquette _lib. Le tampon est alloue par malloc() parce que le pilote le
 * libere lui-meme par free() (voir load_psfcb dans drvimpl.c).
 *
 * Rend 1 en cas de succes, 0 sinon — la convention XSF_TRUE/XSF_FALSE.
 */
int xsf_get_lib(char *nom, void **tampon, unsigned *taille) {
  char chemin[2048];
  if (!nom || !tampon || !taille) return 0;
  snprintf(chemin, sizeof chemin, "%s/%s", g_dossier, nom);

  FILE *f = fopen(chemin, "rb");
  if (!f) return 0;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
  long n = ftell(f);
  if (n <= 0 || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return 0; }

  void *buf = malloc((size_t)n);
  if (!buf) { fclose(f); return 0; }
  size_t lus = fread(buf, 1, (size_t)n, f);
  fclose(f);
  if (lus != (size_t)n) { free(buf); return 0; }

  *tampon = buf;
  *taille = (unsigned)n;
  return 1;
}

/* Rend 0 si le morceau demarre, -1 sinon. */
int ds2sf_demarrer(const uint8_t *fichier, unsigned taille) {
  if (!fichier || taille < 16) return -1;
  return xsf_start((void *)fichier, taille) ? 0 : -1;
}

/* Trames stereo 16 bits a 44100 Hz, comme les autres coeurs du module. */
int ds2sf_rendre(int16_t *sortie, int trames) {
  if (!sortie || trames <= 0) return 0;
  return (int)xsf_gen(sortie, (unsigned)trames);
}

void ds2sf_arreter(void) { xsf_term(); }
