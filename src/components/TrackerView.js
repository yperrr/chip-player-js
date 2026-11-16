import React, { PureComponent } from 'react';

// Couleurs de la coloration syntaxique de libopenmpt, par caractere de
// openmpt_module_highlight_pattern_row_channel() : n note, m note speciale
// (coupure, relache), i instrument, u/v volume, e/f effet, ' ' et '.' vide.
// Les deux premieres suivent le theme ; les autres restent lisibles sur noir
// dans les deux.
const COULEURS = {
  n: 'var(--neutral4)',
  m: 'var(--neutral3)',
  i: 'var(--clickable)',
  u: '#5df', v: '#5df',
  e: '#e8f', f: '#e8f',
  ' ': 'var(--neutral1)', '.': 'var(--neutral1)',
};

/**
 * Vue « tracker » d'un module (MOD, XM, IT, S3M et les 60 autres formats de
 * libopenmpt) : les patterns defilent, la ligne entendue au centre, comme dans
 * le tracker ou le morceau a ete compose.
 *
 * Elle occupe la place du spectrogramme et se redessine seulement quand la
 * ligne, le pattern ou la taille changent. Les cases sont formatees par
 * libopenmpt dans la notation du format d'origine ; quand les canaux ne
 * tiennent pas en entier, libopenmpt les abrege lui-meme (note, puis
 * instrument, puis volume, puis effet), et au-dela d'une note par canal, les
 * canaux en trop sont annonces dans l'en-tete.
 */
export default class TrackerView extends PureComponent {
  constructor(props) {
    super(props);
    this.conteneurRef = React.createRef();
    this.canvasRef = React.createRef();
    this.frame = null;
    this.dernier = '';
    this.couleurs = {};
  }

  componentDidMount() {
    this.observateur = new ResizeObserver(() => { this.dernier = ''; this.dimensionner(); });
    this.observateur.observe(this.conteneurRef.current);
    this.dimensionner();
    this.synchroniser();
  }

  componentDidUpdate() {
    this.dernier = '';
    this.synchroniser();
  }

  componentWillUnmount() {
    this.arreter();
    if (this.observateur) this.observateur.disconnect();
  }

  // Affichee (active) n'est pas animee (running) : en pause, la vue reste,
  // figee sur la ligne courante.
  synchroniser() {
    if (this.props.running) this.demarrer();
    else { this.arreter(); if (this.props.active) requestAnimationFrame(() => this.dessiner()); }
  }

  demarrer() {
    if (this.frame) return;
    const boucle = () => {
      this.frame = requestAnimationFrame(boucle);
      this.dessiner();
    };
    this.frame = requestAnimationFrame(boucle);
  }

  arreter() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  // Le canevas a la taille EXACTE de sa zone, en pixels physiques : du texte
  // etire serait flou.
  dimensionner() {
    const zone = this.conteneurRef.current;
    const canvas = this.canvasRef.current;
    if (!zone || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const l = zone.clientWidth;
    const h = zone.clientHeight;
    if (!l || !h) return;
    canvas.width = Math.round(l * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = l + 'px';
    canvas.style.height = h + 'px';
    this.dpr = dpr;
    this.largeur = l;
    this.hauteur = h;
    // Police et couleurs du theme courant, relues a chaque dimensionnement.
    const style = getComputedStyle(zone);
    this.police = `${style.fontSize} ${style.fontFamily}`;
    this.hauteurLigne = parseInt(style.getPropertyValue('--charH'), 10) || 16;
    for (const [k, v] of Object.entries(COULEURS)) {
      const m = /^var\((--[\w-]+)\)$/.exec(v);
      this.couleurs[k] = m ? (style.getPropertyValue(m[1]).trim() || '#fff') : v;
    }
    this.couleurSelection = style.getPropertyValue('--selected').trim() || '#00f';
    this.couleurTexte = style.getPropertyValue('--neutral2').trim() || '#aaa';
  }

  dessiner() {
    const player = this.props.getPlayer();
    const canvas = this.canvasRef.current;
    if (!player || !player.getTrackerPosition || !canvas || !this.largeur) return;
    const pos = player.getTrackerPosition(this.props.getAudioLatencyMs());
    if (!pos) return;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = this.police;
    ctx.textBaseline = 'top';
    const lc = ctx.measureText('0').width || 8;
    const lh = this.hauteurLigne;
    const colonnes = Math.floor(this.largeur / lc);

    // Largeur des cases : entieres si possible, sinon abregees par libopenmpt.
    const numero = 3;   // « 12 »
    const dispo = colonnes - numero;
    const complet = player.getPattern(pos.pattern, 0);
    if (!complet) return;
    const entiere = complet.lignes && complet.canaux ? (complet.texte[0][0] || '').length : 3;
    let largeurCase = 0;
    let affiches = pos.canaux;
    if (pos.canaux * (entiere + 1) > dispo) {
      largeurCase = Math.floor(dispo / pos.canaux) - 1;
      if (largeurCase < 3) {
        largeurCase = 3;
        affiches = Math.max(1, Math.floor(dispo / 4));
      }
    }
    const cle = [pos.pattern, pos.ligne, largeurCase, affiches, this.largeur, this.hauteur].join(':');
    if (cle === this.dernier) return;
    this.dernier = cle;

    const p = largeurCase ? player.getPattern(pos.pattern, largeurCase) : complet;
    const larg = largeurCase || entiere;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.largeur, this.hauteur);

    // En-tete : position, vitesse, et les canaux.
    const pad2 = n => String(n).padStart(2, '0');
    let entete = `ORD ${pad2(pos.ordre)}/${pad2(pos.ordres)}  PAT ${pad2(pos.pattern)}  ROW ${pad2(pos.ligne)}/${pad2(p.lignes)}  SPD ${pos.vitesse}  BPM ${pos.tempo}`;
    if (affiches < pos.canaux) entete += `  +${pos.canaux - affiches} ch`;
    ctx.fillStyle = this.couleurTexte;
    ctx.fillText(entete.slice(0, colonnes), 0, 2);
    let x = numero * lc;
    for (let k = 0; k < affiches; k++) {
      ctx.fillText(String(k + 1).padEnd(larg + 1).slice(0, larg + 1), x, 2 + lh);
      x += (larg + 1) * lc;
    }

    // Corps : la ligne entendue au centre, sur un bandeau.
    const haut = 2 * lh + 4;
    const nb = Math.max(1, Math.floor((this.hauteur - haut) / lh));
    const centre = Math.floor(nb / 2);
    ctx.fillStyle = this.couleurSelection;
    ctx.fillRect(0, haut + centre * lh, this.largeur, lh);
    for (let i = 0; i < nb; i++) {
      const l = pos.ligne - centre + i;
      if (l < 0 || l >= p.lignes) continue;
      const y = haut + i * lh + 1;
      // Sur le bandeau de la ligne courante, le gris des cases vides et des
      // numeros disparaissait dans le bleu : tout y passe en clair.
      const courante = l === pos.ligne;
      ctx.fillStyle = (courante || l % 4 === 0) ? this.couleurs.n : this.couleurs[' '];
      ctx.fillText(pad2(l).slice(-2), 0, y);
      x = numero * lc;
      for (let k = 0; k < affiches; k++) {
        const t = p.texte[l][k] || '';
        const h = p.couleurs[l][k] || '';
        // Par plages de meme couleur : un fillText par plage, pas par lettre.
        let debut = 0;
        for (let j = 1; j <= t.length; j++) {
          if (j === t.length || h[j] !== h[debut]) {
            const vide = h[debut] === ' ' || h[debut] === '.';
            ctx.fillStyle = courante && vide ? this.couleurs.m : (this.couleurs[h[debut]] || this.couleurs.n);
            ctx.fillText(t.slice(debut, j), x + debut * lc, y);
            debut = j;
          }
        }
        x += (larg + 1) * lc;
      }
    }
  }

  render() {
    return (
      <div className='Visualizer-tracker' ref={this.conteneurRef}
           style={{ display: this.props.active ? 'block' : 'none', width: this.props.width }}>
        <canvas ref={this.canvasRef}/>
      </div>
    );
  }
}
