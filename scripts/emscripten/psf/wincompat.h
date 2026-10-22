/* Bouchon de compatibilite : le pilote vio2sf est ecrit pour Win32, dont il
   n'utilise en realite que des typedefs et trois appels de trace. */
#ifndef XSFC_COMPAT_H
#define XSFC_COMPAT_H

#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <strings.h>

/* BOOL, et au besoin les autres, viennent de desmume/types.h. */
typedef unsigned int   DWORD;
typedef unsigned char  BYTE;
typedef unsigned short WORD;
typedef char *         LPSTR;
typedef const char *   LPCSTR;
typedef void *         LPVOID;
typedef const wchar_t *LPCWSTR;

#ifndef PASCAL
#define PASCAL
#endif
#ifndef TRUE
#define TRUE  1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#define _strnicmp strncasecmp

/* dlog() : seule dependance Win32 reelle, reduite au silence. */
#define OutputDebugString(s)   ((void)(s))
#define STD_OUTPUT_HANDLE      0
#define GetStdHandle(h)        (h)
#define WriteFile(h,b,n,w,o)   ((void)(h),(void)(b),(void)(o), (w) ? (*(w) = (n)) : 0, 1)

#endif
