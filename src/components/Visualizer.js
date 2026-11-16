import pianoKeys from '../images/piano-keys.png';
import Spectrogram from '../Spectrogram';
import TrackerView from './TrackerView';
import PianoRollVisualizer from '../piano-roll/PianoRollVisualizer';
import { isMidiData } from '../piano-roll/midi-parser';
import React, { Fragment, PureComponent } from 'react';

const SPECTROGRAM_MODES = [
  'Linear FFT', 'Log FFT', 'Constant Q'
];
const WEIGHTING_MODES = [
  {label: 'None', description: 'No attenuation'},
  {label: 'A-Weighting', description: 'Darkens low and high frequencies to approximate sensitivity of human hearing.'}
];
const FFT_SIZES = [
  512, 1024, 2048, 4096, 8192
];
const FFT_LABELS = [
  '512', '1K', '2K', '4K', '8K', '16K'
];
const SPEEDS = [
  1, 2, 4
];
const SPEED_LABELS = [
  'Lo', 'Med', 'Hi'
];
const VIS_WIDTH = 448;

// Mode « Tracker » des modules : choix memorise d'une visite a l'autre.
// Desactive par defaut : le visualiseur reste le spectrogramme tant qu'on
// ne choisit pas Tracker dans la liste des modes.
const CLE_TRACKER = 'chipTrackerMode';
const lireTracker = () => {
  try { return localStorage.getItem(CLE_TRACKER) === 'on'; } catch (e) { return false; }
};
const ecrireTracker = on => {
  try { localStorage.setItem(CLE_TRACKER, on ? 'on' : 'off'); } catch (e) { /* stockage indisponible */ }
};

export default class Visualizer extends PureComponent {
  constructor(props) {
    super(props);

    this.state = {
      vizMode: 2,
      weightingMode: 1,
      fftSize: 2048,
      speed: 2,
      tracker: lireTracker(),
    };
    this.pico8CanvasRef = React.createRef();
    this.pico8Frame = null;

    this.freqCanvasRef = React.createRef();
    this.specCanvasRef = React.createRef();
    this.pianoKeysRef = React.createRef();
  }

  componentDidMount() {
    this.spectrogram = new Spectrogram(
      this.props.chipCore,
      this.props.audioCtx,
      this.props.sourceNode,
      this.freqCanvasRef.current,
      this.specCanvasRef.current,
      this.pianoKeysRef.current,
    );
    this.spectrogram.setMode(this.state.vizMode);
    this.spectrogram.setWeighting(this.state.weightingMode);
    this.spectrogram.setSpeed(this.state.speed);

    const isMidi = this.isCurrentSongMidi();
    if (!isMidi) {
      this.spectrogram.setPaused(this.props.visible ? this.props.paused : true);
    }
  }

  // Une cartouche PICO-8 est-elle chargee ? Le lecteur PICO-8 seul a un ecran.
  isPico8() {
    // Le morceau courant, et non le dernier moteur servi : getPlayer() garde
    // le lecteur PICO-8 apres qu'on est passe a autre chose.
    const player = this.props.sequencer?.getPlayer();
    return !!(player && player.playerKey === 'pico8'
      && /\.p8(\.png)?$/i.test(this.props.songPath || ''));
  }

  // Un module tracker est-il charge ? Seul le lecteur libopenmpt sait en
  // montrer les patterns.
  isTracker() {
    const player = this.props.sequencer?.getPlayer();
    return !!(player && player.hasPatterns && player.module);
  }

  showTracker() {
    return this.isTracker() && this.state.tracker && !this.isCurrentSongMidi() && !this.isPico8();
  }

  handleTrackerModeClick = () => {
    ecrireTracker(true);
    this.setState({ tracker: true });
  };

  showPico8Screen() {
    // L'ecran remplace le spectrogramme des qu'une cartouche est chargee ;
    // l'interrupteur Visualizer On/Off de l'en-tete l'affiche ou le cache.
    return this.isPico8();
  }

  // Le dessin suit le rafraichissement de l'ecran, pas l'audio : l'image du
  // programme est lue a chaque trame d'affichage et posee telle quelle sur un
  // canevas de 128 x 128, agrandi par le CSS en pixels nets.
  startPico8Loop() {
    if (this.pico8Frame) return;
    const canvas = this.pico8CanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(128, 128);
    const draw = () => {
      this.pico8Frame = null;
      if (!this.showPico8Screen() || !this.props.visible) return;
      const pixels = this.props.sequencer?.getPlayer()?.getScreen?.();
      if (pixels) {
        image.data.set(pixels);
        ctx.putImageData(image, 0, 0);
      }
      this.pico8Frame = requestAnimationFrame(draw);
    };
    this.pico8Frame = requestAnimationFrame(draw);
  }

  stopPico8Loop() {
    if (this.pico8Frame) cancelAnimationFrame(this.pico8Frame);
    this.pico8Frame = null;
  }

  syncPico8() {
    if (this.showPico8Screen() && this.props.visible) this.startPico8Loop();
    else this.stopPico8Loop();
  }

  componentWillUnmount() {
    this.stopPico8Loop();
  }

  isCurrentSongMidi() {
    return !!(
      (this.props.songPath && /\.(mid|midi|smf)$/i.test(this.props.songPath)) ||
      (this.props.sequencer?.getPlayer()?.fileExtensions?.includes('mid')) ||
      isMidiData(this.props.midiData)
    );
  }

  componentDidUpdate(prevProps) {
    const isMidi = this.isCurrentSongMidi();

    if (!isMidi && !this.showPico8Screen() && !this.showTracker()) {
      this.spectrogram.setPaused(this.props.visible ? this.props.paused : true);
    } else {
      this.spectrogram.setPaused(true);
    }
    this.syncPico8();
  }

  handleModeClick = (e) => {
    const mode = parseInt(e.target.value, 10);
    // Un mode spectrogramme choisi quitte le mode Tracker.
    if (this.state.tracker) ecrireTracker(false);
    this.setState({vizMode: mode, tracker: false});
    this.spectrogram.setMode(mode);
  };

  handleWeightingModeClick = (e) => {
    const mode = parseInt(e.target.value, 10);
    this.setState({weightingMode: mode});
    this.spectrogram.setWeighting(mode);
  };

  handleFFTSizeClick = (e) => {
    const size = parseInt(e.target.value, 10);
    this.setState({fftSize: size});
    this.spectrogram.setFFTSize(size);
  };

  handleSpeedClick = (e) => {
    const speed = parseInt(e.target.value, 10);
    this.setState({ speed: speed });
    this.spectrogram.setSpeed(speed);
  };

  getAudioLatencyMs = () => {
    const { audioCtx, bufferSize: bufferSizeProp, sourceNode } = this.props;
    if (!audioCtx) return 0;
    // bufferSize now arrives as a prop: the tap is a GainNode, which has no
    // bufferSize of its own, and falling back to 2048 would misreport latency
    // whenever the ScriptProcessor was sized differently.
    const bufferSize = bufferSizeProp || sourceNode?.bufferSize || 2048;
    const sampleRate = audioCtx.sampleRate || 44100;
    const bufferLatency = bufferSize / sampleRate;
    const outputLatency = (typeof audioCtx.outputLatency === 'number' ? audioCtx.outputLatency : (audioCtx.baseLatency || 0));
    return (bufferLatency + outputLatency) * 1000;
  };

  render() {
    const isMidi = this.isCurrentSongMidi();
    const isPico8 = this.isPico8();
    const pico8Screen = isPico8;
    const isTracker = this.isTracker() && !isMidi && !isPico8;
    const trackerOn = isTracker && this.state.tracker;

    const specStyle = {
      display: (!isMidi && !pico8Screen && !trackerOn) ? 'block' : 'none',
      width: VIS_WIDTH,
      boxSizing: 'border-box',
    };

    return (
      <div className='Visualizer' style={{ display: this.props.visible ? 'flex' : 'none' }}>
        {/* Ecran de la cartouche PICO-8, a la place du spectrogramme : cale en
            bas du panneau, sur toute sa largeur (moins le pixel de retrait qui
            laisse voir la bordure), et carre — 128 x 128 etire a 448 x 448. */}
        <div className='Visualizer-pico8'
             style={{ display: pico8Screen ? 'flex' : 'none', width: VIS_WIDTH }}>
          <canvas width={128} height={128} ref={this.pico8CanvasRef}/>
        </div>

        {!isMidi && !pico8Screen && (
          <div className='Visualizer-options' style={{ width: VIS_WIDTH, boxSizing: 'border-box' }}>
            <div>
              <span className='VisualizerParams-label'>Mode:</span>
              {
                SPECTROGRAM_MODES.map((mode, i) =>
                  <label key={'m_'+i} className='inline'><input onChange={this.handleModeClick}
                                        type='radio'
                                        name='spectrogram-mode'
                                        checked={!trackerOn && this.state.vizMode === i}
                                        value={i}/>{mode}</label>
                )
              }
              {/* Tracker : seulement pour un module, a la suite des autres. */}
              {isTracker &&
                <label key='m_tracker' className='inline'
                       title="Scroll the module's patterns as in a tracker.">
                  <input onChange={this.handleTrackerModeClick}
                         type='radio'
                         name='spectrogram-mode'
                         checked={trackerOn}
                         value='tracker'/>Tracker</label>}
            </div>
            {!trackerOn && <Fragment>
            {this.state.vizMode === 2 ?
              <div>
                <span className='VisualizerParams-label'>Weighting:</span>
                {
                  WEIGHTING_MODES.map((mode, i) =>
                    <Fragment key={'w_'+i}>
                      <input onClick={this.handleWeightingModeClick}
                             type='radio'
                             id={'w_'+i}
                             name='weighting-mode'
                             defaultChecked={this.state.weightingMode === i}
                             value={i}/>
                      <label htmlFor={'w_'+i} title={mode.description} className='inline'>
                      {mode.label}</label>
                    </Fragment>
                  )
                }
              </div>
              :
              <div>
                <span className='VisualizerParams-label'>FFT Size:</span>
                {
                  FFT_SIZES.map((size, i) =>
                    <Fragment key={'f_'+i}>
                      <input onClick={this.handleFFTSizeClick}
                             type='radio'
                             id={'f_'+i}
                             name='fft-size'
                             defaultChecked={this.state.fftSize === size}
                             value={size}/>
                      <label htmlFor={'f_'+i} className='inline'>{FFT_LABELS[i]}</label>
                    </Fragment>
                  )
                }
              </div>
            }
            <div title="Vertical scrolling speed (pixels per frame)">
              <span className='VisualizerParams-label'>Speed:</span>
              {
                SPEEDS.map((speed, i) =>
                  <Fragment key={'s_'+i}>
                    <input onClick={this.handleSpeedClick}
                           type='radio'
                           id={'s_'+i}
                           name='speed'
                           defaultChecked={this.state.speed === speed}
                           value={speed}/>
                    <label htmlFor={'s_'+i} className='inline'>{SPEED_LABELS[i]}</label>
                  </Fragment>
                )
              }
            </div>
            </Fragment>}
          </div>
        )}

        {/* Vue tracker : les patterns du module, a la place du spectrogramme. */}
        <TrackerView active={trackerOn}
                     running={trackerOn && !!this.props.visible && !this.props.paused}
                     width={VIS_WIDTH}
                     getPlayer={() => this.props.sequencer?.getPlayer()}
                     getAudioLatencyMs={this.getAudioLatencyMs}/>

        {/* Piano Roll visualizer for MIDI files */}
        {isMidi && (
          <PianoRollVisualizer
            width={this.props.theaterMode ? '100%' : VIS_WIDTH}
            midiData={this.props.midiData}
            getCurrentPositionMs={this.props.getCurrentPositionMs}
            getPlaybackRate={this.props.getPlaybackRate}
            getAudioLatencyMs={this.getAudioLatencyMs}
            getIsPlaying={this.props.getIsPlaying}
            paused={this.props.visible ? this.props.paused : true}
            voiceMask={this.props.voiceMask}
            theaterMode={this.props.theaterMode}
            onToggleTheaterMode={this.props.onToggleTheaterMode}
            onAuditionChord={this.props.onAuditionChord}
            style={{
              display: 'flex',
              width: this.props.theaterMode ? '100%' : VIS_WIDTH,
              boxSizing: 'border-box',
            }}
          />
        )}

        {/* Spectrogram visualizer */}
        <canvas style={specStyle} className='Visualizer-analyzer' width={VIS_WIDTH} height={60}
                ref={this.freqCanvasRef}/>
        <canvas style={specStyle} className='Visualizer-spectrogram' width={VIS_WIDTH} height={800}
                ref={this.specCanvasRef}/>
        <img src={pianoKeys}
             className='Visualizer-overlay'
             ref={this.pianoKeysRef}
             alt='Piano keys'
             style={{
               display: (!isMidi && !pico8Screen && !trackerOn && this.state.vizMode === 2) ? 'block' : 'none',
               width: VIS_WIDTH,
             }}/>
      </div>
    );
  }
}
