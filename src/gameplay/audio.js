/**
 * Procedural audio.
 *
 * Every sound in the game is synthesised at runtime with the Web Audio API —
 * there are no audio files and none can be downloaded. The whole soundtrack is
 * three layers:
 *
 *   ambience   continuous beds that track the world: river flow, wind in the
 *              reeds, birdsong that thickens at dawn and dusk, insects at dusk,
 *              a distant woodpecker, the odd frog, and a muffled underwater bed
 *   sfx        one-shot voices spawned from events, pitch/level varied so they
 *              never sound like a looped sample
 *   music      a slow generative pad plus sparse pentatonic plucks; it swells a
 *              little when something happens and recedes to near silence
 *
 * Signal path:
 *
 *   ambience ─┐
 *   sfx      ─┼─► worldBus ─► muffle(LP) ─► lowShelf ─► outBus ─► limiter ─►
 *   music    ─┘                                          ▲        masterGain ─► out
 *                    reverbSend ─► convolver ─► return ──┤
 *                    underwater bed ───────────────────── ┘
 *
 * `muffle` + `lowShelf` are the underwater transition: one exponential glide of
 * a single lowpass (20 kHz → ~300 Hz) plus a low boost, so the crossfade is a
 * genuine filter sweep rather than two paths phasing against each other. It
 * runs over ~0.35 s in both directions and takes the reverb, the bubbly rumble
 * bed and the heartbeat with it.
 *
 * Nothing here throws if audio is unavailable: `AudioContext` may be missing,
 * blocked, or suspended forever in an iframe that never gets a gesture. Every
 * public method is a no-op in that case and `selfTest()` reports why.
 */

import * as THREE from 'three';
import { makeRandom } from '../core/noise.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

/** Every sound name `EVENTS.SFX` may carry. Used by selfTest(). */
const SFX_NAMES = [
  'splash', 'dive', 'surface', 'quack', 'peep', 'bubbles', 'dabble', 'preen',
  'waddle', 'wingbeat', 'fish-rise', 'fish-catch', 'fish-escape', 'chime',
  'plop', 'ripple',
];

/** Minor pentatonic degrees in semitones — the whole musical vocabulary. */
const PENTATONIC = [0, 3, 5, 7, 10];
/** Events that arrive twice (bare + SFX); voiced one frame late. */
const DEFERRED = ['dive', 'surface', 'quack'];

/** Tonal centres the score drifts between, in Hz (D3, F3, A2). */
const ROOTS = [146.83, 174.61, 110.0];

const semis = (root, n) => root * Math.pow(2, n / 12);

/** Pentatonic note `i` steps above the root, i may be negative or > 4. */
function scaleNote(root, i) {
  const oct = Math.floor(i / PENTATONIC.length);
  const deg = ((i % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  return semis(root, PENTATONIC[deg] + oct * 12);
}

export class Audio {
  constructor(ctx) {
    this.ctx = ctx;
    this.ac = null;
    this.ready = false;      // graph built
    this.running = false;    // context actually running (gesture happened)
    this.available = typeof window !== 'undefined'
      && !!(window.AudioContext || window.webkitAudioContext);
    this.blockedReason = this.available ? '' : 'AudioContext missing';

    this.volume = 0.85;
    this.muted = false;
    this.musicEnabled = true;
    this.names = SFX_NAMES.slice();

    // Restore the player's setting if the HUD stored one.
    try {
      const v = window.localStorage?.getItem('duck.audio.volume');
      if (v != null) this.volume = clamp(parseFloat(v) || 0, 0, 1);
      const m = window.localStorage?.getItem('duck.audio.muted');
      if (m != null) this.muted = m === '1';
    } catch (e) { /* private mode; defaults are fine */ }

    this.rand = makeRandom(0xD0CC5EED);

    // ---- state the beds track, all hoisted (update() must not allocate) ----
    this.underwater = 0;          // 0..1 smoothed
    this.depth = 0;               // metres below the surface
    this.flowSpeed = 0;
    this.flowNear = 0;            // fastest water within ~20 m
    this.roughness = 0;           // riffle-iness: fast + shallow + rocky
    this.rockNear = 0;            // 0..1 proximity to a surface-breaking rock
    this.waterProximity = 1;      // 0..1, 1 when on the river
    this.windAmount = 0.8;
    this.reedCover = 0.35;
    this.intensity = 0;           // music swell
    this.listenerY = 0;
    this._listenerX = 0;
    this._listenerZ = 0;
    this._musicAcc = 0;

    this._scratch = new THREE.Vector3();
    this._flow = new THREE.Vector3();
    this._flowB = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._rc = { s: 0, u: 0, distance: 0 };
    this._rcB = { s: 0, u: 0, distance: 0 };

    this._envAcc = 0;
    this._slowAcc = 0;
    this._stepPhase = 0;
    this._stepFoot = 0;
    this._lastEvent = Object.create(null);   // name → last play time (dedupe)
    this._deferred = { dive: null, surface: null, quack: null };
    this._retired = [];                      // { t, n[] } voices awaiting cleanup
    this._ambience = Object.create(null);
    this._offs = [];                         // event unsubscribers
    this._gestureHandler = null;
    this._visHandler = null;

    // Scheduler clocks, in context time.
    this._nextBird = 0;
    this._nextInsect = 0;
    this._nextFrog = 0;
    this._nextPecker = 0;
    this._nextPluck = 0;
    this._nextChord = 0;
    this._nextHeart = 0;
    this._rootIndex = 0;
    this._padVoices = [];

    this.stats = { voicesSpawned: 0, voicesActive: 0, ambienceVoices: 0 };
  }

  /* ------------------------------------------------------------------ boot */

  async init() {
    if (!this.available) {
      console.info('[audio] no AudioContext in this browser — running silent');
      this._bindEvents();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      // 'interactive' keeps latency low; a bigger buffer would drift from the
      // visuals on splashes.
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      this.available = false;
      this.blockedReason = `AudioContext constructor threw: ${err.message}`;
      console.info('[audio] context unavailable — running silent');
      this._bindEvents();
      return;
    }

    try {
      this._buildBuffers();
      this._buildGraph();
      this.ready = true;
    } catch (err) {
      this.available = false;
      this.blockedReason = `graph build failed: ${err.message}`;
      console.warn('[audio] could not build the graph — running silent', err);
      this._bindEvents();
      return;
    }

    this._bindEvents();
    this._bindGestures();

    // Autoplay is usually blocked; if it is not (or a gesture already
    // happened) this starts the world immediately.
    this._tryResume();
  }

  _bindGestures() {
    if (this._gestureHandler) return;
    const onGesture = () => { this._tryResume(); };
    this._gestureHandler = onGesture;
    for (const t of ['pointerdown', 'keydown', 'touchstart', 'mousedown', 'wheel']) {
      window.addEventListener(t, onGesture, { passive: true });
    }
    this.ac?.addEventListener?.('statechange', () => {
      if (this.ac.state === 'running' && !this.running) this._onRunning();
    });

    this._visHandler = () => {
      if (!this.ac || !this.running) return;
      if (document.hidden) {
        this._ramp(this.masterGain.gain, 0.0001, 0.08);
        setTimeout(() => {
          if (document.hidden) this.ac?.suspend?.().catch(() => {});
        }, 220);
      } else {
        this.ac.resume?.().catch(() => {});
        this._applyMaster();
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);
  }

  _tryResume() {
    if (!this.ac) return;
    if (this.ac.state === 'running') { this._onRunning(); return; }
    const p = this.ac.resume?.();
    if (p && p.then) p.then(() => this._onRunning()).catch(() => {});
  }

  /** Called the first time the context is genuinely running. */
  _onRunning() {
    if (!this.ac || this.ac.state !== 'running') return;
    const first = !this.running;
    this.running = true;
    this._applyMaster();
    if (first) {
      try {
        this._startAmbience();
        this._startMusic();
        const t = this.ac.currentTime;
        this._nextBird = t + 1.2;
        this._nextInsect = t + 3.0;
        this._nextFrog = t + 7.0;
        this._nextPecker = t + 26.0;
        this._nextPluck = t + 9.0;
        this._nextChord = t + 0.05;
        // Fade the world in rather than punching it on.
        this.masterGain.gain.setValueAtTime(0.0001, t);
        this._ramp(this.masterGain.gain, this._masterTarget(), 1.6);
      } catch (err) {
        console.warn('[audio] ambience failed to start', err);
      }
    }
  }

  /* ------------------------------------------------------------ the graph */

  _buildGraph() {
    const ac = this.ac;

    this.masterGain = ac.createGain();
    this.masterGain.gain.value = this._masterTarget();

    // Gentle bus glue, mostly to stop a stack of splashes clipping.
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 10;
    this.limiter.ratio.value = 6;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;

    this.outBus = ac.createGain();
    this.outBus.gain.value = 1;

    // Underwater: a single lowpass sweep plus a low shelf. One filter keeps
    // the transition phase-coherent; two parallel paths would flange.
    this.muffle = ac.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.4;

    this.lowShelf = ac.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 220;
    this.lowShelf.gain.value = 0;

    this.worldBus = ac.createGain();
    this.worldBus.gain.value = 1;

    this.ambienceBus = ac.createGain();
    this.ambienceBus.gain.value = 0.55;
    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = 0.9;
    this.musicBus = ac.createGain();
    this.musicBus.gain.value = 0.0;   // swells in from silence

    this.reverbSend = ac.createGain();
    this.reverbSend.gain.value = 1;
    this.convolver = ac.createConvolver();
    this.convolver.buffer = this._makeImpulse(1.9, 2.2);
    this.reverbReturn = ac.createGain();
    this.reverbReturn.gain.value = 0.5;

    // Underwater bed sits after the muffle — it is already dark, and it must
    // not be filtered away by the very filter it is announcing.
    this.uwBus = ac.createGain();
    this.uwBus.gain.value = 0.0001;

    // Silent sink for selfTest() voice construction.
    this.testBus = ac.createGain();
    this.testBus.gain.value = 0;

    this.ambienceBus.connect(this.worldBus);
    this.sfxBus.connect(this.worldBus);
    this.musicBus.connect(this.worldBus);
    this.worldBus.connect(this.muffle);
    this.muffle.connect(this.lowShelf);
    this.lowShelf.connect(this.outBus);

    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.outBus);

    this.uwBus.connect(this.outBus);
    this.outBus.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ac.destination);

    // Listener rolloff has to agree with the camera: the rig sits 4–8 m behind
    // the duck, so refDistance is a little under that and the curve is gentle.
    const l = ac.listener;
    if (l.forwardX) {
      l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setOrientation) {
      l.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  _masterTarget() {
    return this.muted ? 0.0001 : clamp(this.volume, 0, 1) * 0.9;
  }

  /* --------------------------------------------------------------- buffers */

  _buildBuffers() {
    const ac = this.ac;
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 4);
    const rnd = makeRandom(0xBEEF77);

    const white = ac.createBuffer(1, n, sr);
    const wd = white.getChannelData(0);
    for (let i = 0; i < n; i++) wd[i] = rnd() * 2 - 1;

    // Paul Kellet's economy pink filter.
    const pink = ac.createBuffer(1, n, sr);
    const pd = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = wd[i];
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      pd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }

    // Leaky integrator → brown.
    const brown = ac.createBuffer(1, n, sr);
    const bd = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * wd[i]) * 0.998;
      bd[i] = clamp(last * 3.2, -1, 1);
    }

    this.buffers = { white, pink, brown };
  }

  /**
   * A soft outdoor space: a handful of early reflections off the far bank,
   * then a short dark diffuse tail. Not a cathedral — a valley.
   */
  _makeImpulse(seconds = 1.9, decay = 2.2) {
    const ac = this.ac;
    const sr = ac.sampleRate;
    const n = Math.max(1, Math.floor(sr * seconds));
    const buf = ac.createBuffer(2, n, sr);
    const rnd = makeRandom(0x5EA51DE);
    const taps = [0.011, 0.019, 0.031, 0.047, 0.068, 0.099];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      // Damped diffuse tail: white noise shaped by a power curve, then a
      // one-pole lowpass whose cutoff falls with time so the tail darkens.
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, decay) * (0.25 + 0.75 * Math.pow(1 - t, 0.4));
        const x = (rnd() * 2 - 1) * env;
        const a = lerp(0.55, 0.12, t);   // darkens as it decays
        lp += a * (x - lp);
        d[i] = lp;
      }
      // Early reflections, offset per channel for width.
      for (let k = 0; k < taps.length; k++) {
        const idx = Math.floor((taps[k] + ch * 0.0037) * sr);
        if (idx < n) d[idx] += (0.42 - k * 0.055) * (ch ? -1 : 1);
      }
      // Normalise.
      let peak = 1e-6;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
      const g = 0.7 / peak;
      for (let i = 0; i < n; i++) d[i] *= g;
    }
    return buf;
  }

  /* ------------------------------------------------------- small utilities */

  _now() { return this.ac ? this.ac.currentTime : 0; }

  _ramp(param, value, tau = 0.12) {
    const t = this._now();
    try { param.setTargetAtTime(value, t, Math.max(0.005, tau * 0.34)); }
    catch (e) { param.value = value; }
  }

  /** Attack / hold / exponential decay on a gain param. Returns the end time. */
  _env(param, t0, peak, attack, decay, hold = 0) {
    const p = Math.max(0.0002, peak);
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(p, t0 + attack);
    if (hold > 0) param.setValueAtTime(p, t0 + attack + hold);
    param.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
    return t0 + attack + hold + decay;
  }

  _noise(kind, t0, dur, rate = 1) {
    const src = this.ac.createBufferSource();
    src.buffer = this.buffers[kind] || this.buffers.white;
    src.playbackRate.value = rate;
    const len = src.buffer.duration;
    const offset = this.rand() * Math.max(0.01, len - dur * rate - 0.01);
    src.start(t0, offset, dur * rate + 0.02);
    return src;
  }

  _loopNoise(kind, rate = 1) {
    const src = this.ac.createBufferSource();
    src.buffer = this.buffers[kind] || this.buffers.white;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(this._now() + 0.02, this.rand() * 3.0);
    return src;
  }

  _osc(type, freq, t0) {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    return o;
  }

  _filter(type, freq, q = 1) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _gain(v = 1) {
    const g = this.ac.createGain();
    g.gain.value = v;
    return g;
  }

  /**
   * A tremolo multiplier: audio passes through `mul` at unity and the LFO
   * pushes it by ±depth. It has to be its own node — modulating an *enveloped*
   * gain directly leaks the raw oscillator whenever the envelope is at zero,
   * which is how a quack turns into a permanent buzz.
   */
  _trem(freq, depth, t, type = 'square') {
    const mul = this._gain(1);
    const lfo = this._osc(type, freq, t);
    const d = this._gain(depth);
    lfo.connect(d).connect(mul.gain);
    return { mul, lfo, d };
  }

  /**
   * Routing for a one-shot voice: a gain node already connected to the SFX bus
   * (through a panner when the sound has a world position) and to the reverb.
   */
  _dest(opts, reverb = 0.22) {
    const ac = this.ac;
    const g = ac.createGain();
    g.gain.value = 1;
    if (opts && opts.silent) {
      g.connect(this.testBus);
      return g;
    }
    const p = opts && opts.position;
    let node = g;
    if (p && typeof p.x === 'number') {
      const pan = ac.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      // Matched to the camera: the rig sits 4–8 m back, so refDistance is just
      // inside that and the curve is gentle — an inverse rolloff of 1 would put
      // a bird on the far bank 25 dB down and effectively delete the world.
      // Ambient wildlife passes its own, gentler rolloff.
      pan.refDistance = opts.ref || 4;
      pan.maxDistance = 200;
      pan.rolloffFactor = opts.rolloff || 0.75;
      if (pan.positionX) {
        pan.positionX.value = p.x; pan.positionY.value = p.y; pan.positionZ.value = p.z;
      } else if (pan.setPosition) {
        pan.setPosition(p.x, p.y, p.z);
      }
      g.connect(pan);
      node = pan;
      this._panners = (this._panners || 0) + 1;
    }
    node.connect(this.sfxBus);
    if (reverb > 0) {
      const send = ac.createGain();
      send.gain.value = reverb;
      node.connect(send);
      send.connect(this.reverbSend);
      this._retire(this._now() + 8, send);
    }
    return g;
  }

  /** Disconnect these nodes once `t` has passed. Cleanup happens in update(). */
  _retire(t, ...nodes) {
    this._retired.push({ t, n: nodes });
    this.stats.voicesSpawned++;
  }

  /* --------------------------------------------------------------- ambience */

  _startAmbience() {
    const ac = this.ac;
    const A = this._ambience;

    // ---- river: three bands, each tracking a different aspect of the flow ---
    // Body: the low roll of moving water.
    A.flowLowSrc = this._loopNoise('brown', 1);
    A.flowLowFilter = this._filter('lowpass', 340, 0.7);
    A.flowLow = this._gain(0.0001);
    A.flowLowSrc.connect(A.flowLowFilter).connect(A.flowLow);

    // Mid: the "moving past you" band; its centre frequency is the brightness.
    A.flowMidSrc = this._loopNoise('pink', 1);
    A.flowMidFilter = this._filter('bandpass', 800, 0.65);
    A.flowMid = this._gain(0.0001);
    A.flowMidSrc.connect(A.flowMidFilter).connect(A.flowMid);

    // Hiss: riffles breaking over rocks.
    A.flowHissSrc = this._loopNoise('white', 1);
    A.flowHissFilter = this._filter('highpass', 2400, 0.8);
    A.flowHissTilt = this._filter('lowpass', 7000, 0.5);
    A.flowHiss = this._gain(0.0001);
    A.flowHissSrc.connect(A.flowHissFilter).connect(A.flowHissTilt).connect(A.flowHiss);

    // The river pans a little toward the faster side of the channel.
    A.flowPan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    A.flowSum = this._gain(1);
    A.flowLow.connect(A.flowSum);
    A.flowMid.connect(A.flowSum);
    A.flowHiss.connect(A.flowSum);
    if (A.flowPan) A.flowSum.connect(A.flowPan).connect(this.ambienceBus);
    else A.flowSum.connect(this.ambienceBus);
    // A touch of the river in the reverb glues it to the valley.
    A.flowSend = this._gain(0.12);
    A.flowSum.connect(A.flowSend).connect(this.reverbSend);

    // ---- wind ------------------------------------------------------------
    A.windSrc = this._loopNoise('pink', 0.85);
    A.windFilter = this._filter('lowpass', 430, 0.9);
    A.wind = this._gain(0.0001);
    A.windSrc.connect(A.windFilter).connect(A.wind).connect(this.ambienceBus);

    // Reeds: a brighter band gusting on a slow LFO pair (non-repeating because
    // the two rates are irrational multiples of each other).
    A.reedSrc = this._loopNoise('white', 1);
    A.reedFilter = this._filter('bandpass', 2900, 1.1);
    A.reed = this._gain(0.0001);
    A.reedSrc.connect(A.reedFilter).connect(A.reed).connect(this.ambienceBus);

    A.gustLfoA = this._osc('sine', 0.083, this._now());
    A.gustLfoB = this._osc('sine', 0.037, this._now());
    A.gustDepthA = this._gain(0.02);
    A.gustDepthB = this._gain(0.012);
    A.gustLfoA.connect(A.gustDepthA).connect(A.reed.gain);
    A.gustLfoB.connect(A.gustDepthB).connect(A.wind.gain);
    // The same gusts open the reed band's filter a little.
    A.gustFilterDepth = this._gain(700);
    A.gustLfoA.connect(A.gustFilterDepth).connect(A.reedFilter.frequency);
    A.gustLfoA.start();
    A.gustLfoB.start();

    // ---- insects (a shimmering high bed, dusk and night) ------------------
    A.insectSrc = this._loopNoise('white', 1);
    A.insectFilter = this._filter('bandpass', 6300, 9);
    A.insect = this._gain(0.0001);
    A.insectSrc.connect(A.insectFilter).connect(A.insect).connect(this.ambienceBus);

    // ---- underwater bed ---------------------------------------------------
    A.uwRumbleSrc = this._loopNoise('brown', 0.7);
    A.uwRumbleFilter = this._filter('lowpass', 200, 1.2);
    A.uwRumble = this._gain(0.55);
    A.uwRumbleSrc.connect(A.uwRumbleFilter).connect(A.uwRumble).connect(this.uwBus);

    A.uwHissSrc = this._loopNoise('pink', 0.6);
    A.uwHissFilter = this._filter('bandpass', 480, 0.8);
    A.uwHiss = this._gain(0.16);
    A.uwHissSrc.connect(A.uwHissFilter).connect(A.uwHiss).connect(this.uwBus);

    // Slow pressure swell so the underwater bed breathes.
    A.uwLfo = this._osc('sine', 0.11, this._now());
    A.uwLfoDepth = this._gain(55);
    A.uwLfo.connect(A.uwLfoDepth).connect(A.uwRumbleFilter.frequency);
    A.uwLfo.start();

    this.stats.ambienceVoices = Object.keys(A).length;
  }

  /* ----------------------------------------------------------------- music */

  _startMusic() {
    const ac = this.ac;
    this._padFilter = this._filter('lowpass', 900, 0.6);
    this._padSum = this._gain(0.9);
    this._padFilter.connect(this._padSum).connect(this.musicBus);
    this._padSend = this._gain(0.5);
    this._padSum.connect(this._padSend).connect(this.reverbSend);

    // Three held voices, each two slightly detuned oscillators. They are never
    // stopped; the chord changes by gliding their frequencies, so the pad has
    // no seam to hear.
    for (let i = 0; i < 3; i++) {
      const g = this._gain(0.0001);
      const a = this._osc('sine', 220, this._now());
      const b = this._osc('triangle', 220, this._now());
      b.detune.value = 7 + i * 4;
      a.detune.value = -6 - i * 3;
      const bg = this._gain(0.35);
      a.connect(g);
      b.connect(bg).connect(g);
      g.connect(this._padFilter);
      a.start(); b.start();
      this._padVoices.push({ a, b, g });
    }
    this._root = ROOTS[0];
    this._ramp(this.musicBus.gain, 0.0001, 0.5);
  }

  _setChord(t) {
    if (!this._padVoices.length) return;
    // Drift the tonal centre every few minutes so nothing ever repeats.
    if (this.rand() < 0.22) {
      this._rootIndex = (this._rootIndex + 1 + Math.floor(this.rand() * 2)) % ROOTS.length;
      this._root = ROOTS[this._rootIndex];
    }
    const base = Math.floor(this.rand() * 3);      // which degree is the bass
    const spread = [0, 2, 4][Math.floor(this.rand() * 3)] || 2;
    const degrees = [base, base + 2, base + spread + 3];
    const glide = 6 + this.rand() * 8;
    for (let i = 0; i < this._padVoices.length; i++) {
      const v = this._padVoices[i];
      const f = scaleNote(this._root, degrees[i]) * (i === 2 ? 2 : 1);
      try {
        v.a.frequency.setTargetAtTime(f, t, glide * 0.3);
        v.b.frequency.setTargetAtTime(f * 1.0009, t, glide * 0.3);
      } catch (e) { /* ignore */ }
      const level = (0.16 - i * 0.03) * (0.6 + 0.4 * this.rand());
      v.g.gain.setTargetAtTime(Math.max(0.0005, level), t, glide * 0.35);
    }
    this._padFilter.frequency.setTargetAtTime(620 + this.rand() * 700 + this.intensity * 500, t, 4);
    this._nextChord = t + 17 + this.rand() * 22;
  }

  /** A single plucked note: soft attack, long dark tail, plenty of reverb. */
  _pluck(t, freq, level = 0.1, out = null) {
    const g = this._gain(0.0001);
    const body = this._filter('lowpass', 1400 + this.rand() * 900, 0.9);
    const a = this._osc('triangle', freq, t);
    const b = this._osc('sine', freq * 2.002, t);
    const bg = this._gain(0.22);
    a.connect(g); b.connect(bg).connect(g);
    g.connect(body).connect(out || this.musicBus);
    const send = this._gain(out ? 0 : 0.55);
    body.connect(send).connect(this.reverbSend);
    const dur = 1.6 + this.rand() * 2.4;
    this._env(g.gain, t, level, 0.012, dur);
    // Strings go slightly flat as they decay.
    a.frequency.setValueAtTime(freq, t);
    a.frequency.exponentialRampToValueAtTime(freq * 0.997, t + dur);
    a.start(t); b.start(t);
    a.stop(t + dur + 0.1); b.stop(t + dur + 0.1);
    this._retire(t + dur + 0.3, a, b, bg, g, body, send);
  }

  _scheduleMusic(t) {
    if (!this.musicEnabled) return;
    if (t >= this._nextChord) this._setChord(t);

    if (t >= this._nextPluck) {
      // Sparse by default; a little denser when the world is busy. Never
      // metronomic — the gap is drawn fresh every time.
      const busy = this.intensity;
      const gap = lerp(11, 3.2, busy) * (0.55 + this.rand() * 1.5);
      this._nextPluck = t + gap;
      const level = (0.055 + 0.06 * busy) * (0.7 + 0.5 * this.rand());
      const step = Math.floor(this.rand() * 7) - 1;
      this._pluck(t, scaleNote(this._root, step) * 4, level);
      // Occasionally a two or three note phrase, answered a beat later.
      if (this.rand() < 0.3 + busy * 0.25) {
        const n2 = step + (this.rand() < 0.5 ? 1 : 2);
        this._pluck(t + 0.42 + this.rand() * 0.3, scaleNote(this._root, n2) * 4, level * 0.8);
        if (this.rand() < 0.35) {
          this._pluck(t + 0.95 + this.rand() * 0.4, scaleNote(this._root, n2 + 2) * 4, level * 0.6);
        }
      }
    }
  }

  /* ------------------------------------------------------------- schedulers */

  /** How much birdsong the hour deserves. Dawn and dusk peak, night is quiet. */
  _birdDensity(tod) {
    const dawn = Math.exp(-Math.pow((tod - 0.24) / 0.075, 2));
    const dusk = Math.exp(-Math.pow((tod - 0.74) / 0.085, 2));
    const day = tod > 0.28 && tod < 0.72 ? 0.34 : 0.0;
    const night = (tod < 0.14 || tod > 0.88) ? 0.02 : 0;
    return clamp(dawn + dusk * 0.85 + day + night, 0.02, 1.35);
  }

  _scheduleAmbientEvents(t) {
    const tod = clamp(this.ctx.settings?.timeOfDay ?? 0.3, 0, 1);
    const midday = clamp(1 - Math.min(Math.abs(tod - 0.5) / 0.34, 1), 0, 1); // 1 at noon
    const dusk = Math.exp(-Math.pow((tod - 0.78) / 0.1, 2)) + Math.exp(-Math.pow((tod - 0.2) / 0.09, 2));

    if (t >= this._nextBird) {
      const d = this._birdDensity(tod);
      const gap = lerp(9.5, 1.3, clamp(d / 1.35, 0, 1)) * (0.45 + this.rand() * 1.7);
      this._nextBird = t + gap;
      if (this.underwater < 0.5) this._bird(t, tod);
    }

    if (t >= this._nextInsect) {
      this._nextInsect = t + 1.6 + this.rand() * 4.5;
      if (dusk > 0.25 && this.underwater < 0.4) this._cricket(t, 0.16 * clamp(dusk, 0, 1));
    }

    if (t >= this._nextFrog) {
      this._nextFrog = t + 9 + this.rand() * 22;
      if ((dusk > 0.2 || midday < 0.35) && this.waterProximity > 0.4 && this.underwater < 0.4) {
        this._frog(t);
      }
    }

    if (t >= this._nextPecker) {
      this._nextPecker = t + 45 + this.rand() * 90;
      if (tod > 0.2 && tod < 0.8 && this.underwater < 0.4) this._woodpecker(t);
    }

    // Underwater heartbeat, only when the breath meter is getting short.
    const breath = this.ctx.player?.breath;
    if (this.underwater > 0.5 && typeof breath === 'number' && breath < 0.55) {
      if (t >= this._nextHeart) {
        const urgency = clamp(1 - breath / 0.55, 0, 1);
        this._nextHeart = t + lerp(1.05, 0.42, urgency);
        this._heartbeat(t, 0.1 + 0.35 * urgency);
      }
    } else {
      this._nextHeart = t;
    }
  }

  /* ------------------------------------------------------- ambient one-shots */

  _bird(t, tod) {
    // Place it in the world around the listener so birds come from the banks.
    const ang = this.rand() * Math.PI * 2;
    const dist = 9 + this.rand() * 30;
    const p = this._pos;
    p.set(
      this._listenerX + Math.cos(ang) * dist,
      this.listenerY + 2.5 + this.rand() * 9,
      this._listenerZ + Math.sin(ang) * dist,
    );
    const far = clamp(dist / 40, 0, 1);
    // voice → distance tone → panner chain. Far birds lose their top end,
    // which is most of what makes a wood matter feel deep.
    const dest = this._dest({ position: p, ref: 8, rolloff: 0.35 }, 0.42 + far * 0.3);
    const tone = this._filter('lowpass', lerp(9000, 3200, far), 0.7);
    const voice = this._gain(1);
    voice.connect(tone).connect(dest);

    // Dawn favours the warblers and the pigeon; dusk brings out the crows.
    const bias = tod < 0.35 ? -0.1 : tod > 0.66 ? 0.12 : 0;
    const r = clamp(this.rand() + bias, 0, 0.999);
    const level = (0.09 + this.rand() * 0.06) * lerp(1, 0.45, far);
    let end = t;

    if (r < 0.34) {
      // Warbler: a quick descending cascade.
      const notes = 4 + Math.floor(this.rand() * 4);
      let f = 2400 + this.rand() * 1600;
      for (let i = 0; i < notes; i++) {
        const nt = t + i * (0.055 + this.rand() * 0.05);
        end = Math.max(end, this._chirp(voice, nt, f, f * (0.86 + this.rand() * 0.2), 0.06 + this.rand() * 0.04, level));
        f *= 0.9 + this.rand() * 0.08;
      }
    } else if (r < 0.58) {
      // Two-note "tea-cher" call.
      const f = 1900 + this.rand() * 1500;
      end = this._chirp(voice, t, f, f * 1.18, 0.1, level);
      end = Math.max(end, this._chirp(voice, t + 0.19, f * 0.82, f * 0.7, 0.13, level * 0.85));
    } else if (r < 0.76) {
      // Trill: one note with fast vibrato.
      const f = 2600 + this.rand() * 1400;
      end = this._trill(voice, t, f, 0.34 + this.rand() * 0.3, level * 0.9);
    } else if (r < 0.92) {
      // Wood pigeon: soft, low, five syllables. Very dawn.
      const f = 420 + this.rand() * 90;
      for (let i = 0; i < 5; i++) {
        const nt = t + i * 0.26;
        const up = i === 1 || i === 3;
        end = Math.max(end, this._coo(voice, nt, f * (up ? 1.16 : 1), 0.2, level * 0.75));
      }
    } else {
      // Distant crow — harsh, rare, a full stop in the texture.
      for (let i = 0; i < 2 + Math.floor(this.rand() * 2); i++) {
        const nt = t + i * (0.28 + this.rand() * 0.12);
        end = Math.max(end, this._caw(voice, nt, 620 + this.rand() * 140, level * 0.55));
      }
    }
    this._retire(end + 1.0, voice, tone, dest);
  }

  /** One clean bird note gliding from f0 to f1. */
  _chirp(out, t, f0, f1, dur, level) {
    const o = this._osc('sine', f0, t);
    const g = this._gain(0.0001);
    o.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t + dur);
    // A little third harmonic keeps it from sounding like a test tone.
    const h = this._osc('triangle', f0 * 2, t);
    h.frequency.exponentialRampToValueAtTime(Math.max(60, f1 * 2), t + dur);
    const hg = this._gain(0.12);
    o.connect(g); h.connect(hg).connect(g);
    g.connect(out);
    const end = this._env(g.gain, t, level, 0.008, dur * 0.9, dur * 0.2);
    o.start(t); h.start(t);
    o.stop(end + 0.05); h.stop(end + 0.05);
    this._retire(end + 0.2, o, h, hg, g);
    return end;
  }

  _trill(out, t, f, dur, level) {
    const o = this._osc('sine', f, t);
    const g = this._gain(0.0001);
    const lfo = this._osc('sine', 22 + this.rand() * 16, t);
    const lg = this._gain(f * 0.09);
    lfo.connect(lg).connect(o.frequency);
    o.connect(g).connect(out);
    const end = this._env(g.gain, t, level, 0.02, dur * 0.5, dur * 0.5);
    o.start(t); lfo.start(t);
    o.stop(end + 0.05); lfo.stop(end + 0.05);
    this._retire(end + 0.2, o, lfo, lg, g);
    return end;
  }

  _coo(out, t, f, dur, level) {
    const o = this._osc('sine', f, t);
    const g = this._gain(0.0001);
    const bp = this._filter('bandpass', f * 1.6, 3);
    o.frequency.setValueAtTime(f * 0.94, t);
    o.frequency.linearRampToValueAtTime(f, t + dur * 0.35);
    o.frequency.linearRampToValueAtTime(f * 0.92, t + dur);
    o.connect(g).connect(bp).connect(out);
    const end = this._env(g.gain, t, level, 0.05, dur * 0.7, dur * 0.3);
    o.start(t); o.stop(end + 0.05);
    this._retire(end + 0.2, o, g, bp);
    return end;
  }

  _caw(out, t, f, level) {
    const o = this._osc('sawtooth', f, t);
    const g = this._gain(0.0001);
    const bp = this._filter('bandpass', 1200, 2.2);
    const tr = this._trem(42, 0.35, t);
    o.frequency.setValueAtTime(f * 1.1, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 0.22);
    o.connect(g).connect(tr.mul).connect(bp).connect(out);
    const end = this._env(g.gain, t, level, 0.015, 0.2, 0.05);
    o.start(t); tr.lfo.start(t);
    o.stop(end + 0.05); tr.lfo.stop(end + 0.05);
    this._retire(end + 0.2, o, tr.lfo, tr.d, tr.mul, g, bp);
    return end;
  }

  _cricket(t, level) {
    const ang = this.rand() * Math.PI * 2;
    const d = 4 + this.rand() * 14;
    this._pos.set(this._listenerX + Math.cos(ang) * d, this.listenerY + 0.3, this._listenerZ + Math.sin(ang) * d);
    const dest = this._dest({ position: this._pos, ref: 6, rolloff: 0.5 }, 0.15);
    const bp = this._filter('bandpass', 4200 + this.rand() * 1800, 14);
    const g = this._gain(0.0001);
    const src = this._noise('white', t, 0.5);
    src.connect(g).connect(bp).connect(dest);
    // Three to five pulses — the chirp of a bush cricket.
    const pulses = 3 + Math.floor(this.rand() * 3);
    const step = 0.055 + this.rand() * 0.02;
    let end = t;
    for (let i = 0; i < pulses; i++) {
      const nt = t + i * step;
      g.gain.setValueAtTime(0.0001, nt);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0005, level), nt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, nt + step * 0.75);
      end = nt + step;
    }
    src.stop(end + 0.1);
    this._retire(end + 0.3, src, g, bp, dest);
  }

  _frog(t) {
    const ang = this.rand() * Math.PI * 2;
    const d = 8 + this.rand() * 22;
    this._pos.set(this._listenerX + Math.cos(ang) * d, this.listenerY + 0.05, this._listenerZ + Math.sin(ang) * d);
    const dest = this._dest({ position: this._pos, ref: 9, rolloff: 0.4 }, 0.4);
    const f = 90 + this.rand() * 60;
    const o = this._osc('sawtooth', f, t);
    const g = this._gain(0.0001);
    const bp = this._filter('bandpass', 520 + this.rand() * 260, 4);
    const tr = this._trem(22 + this.rand() * 14, 0.5, t);
    o.connect(g).connect(tr.mul).connect(bp).connect(dest);
    let end = t;
    const croaks = 1 + Math.floor(this.rand() * 3);
    for (let i = 0; i < croaks; i++) {
      const nt = t + i * (0.36 + this.rand() * 0.2);
      end = this._env(g.gain, nt, 0.13, 0.02, 0.16, 0.08);
    }
    o.start(t); tr.lfo.start(t);
    o.stop(end + 0.05); tr.lfo.stop(end + 0.05);
    this._retire(end + 0.3, o, tr.lfo, tr.d, tr.mul, g, bp, dest);
  }

  _woodpecker(t) {
    const ang = this.rand() * Math.PI * 2;
    const d = 25 + this.rand() * 40;
    this._pos.set(this._listenerX + Math.cos(ang) * d, this.listenerY + 6 + this.rand() * 6, this._listenerZ + Math.sin(ang) * d);
    const dest = this._dest({ position: this._pos, ref: 14, rolloff: 0.25 }, 0.65);
    const lp = this._filter('lowpass', 2600, 0.8);
    const g = this._gain(0.0001);
    const src = this._noise('white', t, 0.9);
    const bp = this._filter('bandpass', 1500 + this.rand() * 700, 2.5);
    src.connect(g).connect(bp).connect(lp).connect(dest);
    const hits = 8 + Math.floor(this.rand() * 8);
    const step = 0.036 + this.rand() * 0.014;
    let end = t;
    for (let i = 0; i < hits; i++) {
      const nt = t + i * step;
      const fall = 1 - i / hits * 0.45;
      g.gain.setValueAtTime(0.0001, nt);
      g.gain.exponentialRampToValueAtTime(0.32 * fall, nt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, nt + step * 0.85);
      end = nt + step;
    }
    src.stop(end + 0.1);
    this._retire(end + 0.4, src, g, bp, lp, dest);
  }

  _heartbeat(t, level) {
    const dest = this._gain(1);
    dest.connect(this.uwBus);
    const thump = (nt, lv) => {
      const o = this._osc('sine', 62, nt);
      const g = this._gain(0.0001);
      o.frequency.exponentialRampToValueAtTime(38, nt + 0.16);
      o.connect(g).connect(dest);
      const end = this._env(g.gain, nt, lv, 0.012, 0.16);
      o.start(nt); o.stop(end + 0.05);
      this._retire(end + 0.2, o, g);
      return end;
    };
    thump(t, level);
    const end = thump(t + 0.19, level * 0.7);
    this._retire(end + 0.3, dest);
  }

  /* ------------------------------------------------------------------- sfx */

  /**
   * Public one-shot entry point. `opts`: { position, volume, rate, silent }.
   * Unknown names fall back to a soft plop so a new emitter is never silent
   * and never throws.
   */
  play(name, opts) {
    if (!this.ready || !this.running || this.muted) return false;
    if (this._retired.length > 190) return false;      // voice storm guard
    const t = this._now() + 0.005;
    // Per-name rate limit: several systems can emit the same frame.
    const last = this._lastEvent[name] || -1;
    if (t - last < 0.035) return false;
    this._lastEvent[name] = t;
    try {
      return this._synth(name, t, opts || {});
    } catch (err) {
      if (!this._warned) { this._warned = true; console.warn('[audio] voice failed', name, err); }
      return false;
    }
  }

  _synth(name, t, o) {
    const vol = clamp(o.volume != null ? o.volume : 1, 0, 4);
    const rate = o.rate != null ? o.rate : 1;
    switch (name) {
      case 'splash':  return this._vSplash(t, o, vol, o.strength != null ? o.strength : 0.7);
      case 'dive':    return this._vDive(t, o, vol);
      case 'surface': return this._vSurface(t, o, vol);
      case 'quack':   return this._vQuack(t, o, vol, rate);
      case 'peep':    return this._vQuack(t, o, vol, Math.max(1.6, rate));
      case 'bubbles': return this._vBubbles(t, o, vol, o.count || 8);
      case 'dabble':  return this._vDabble(t, o, vol);
      case 'preen':   return this._vPreen(t, o, vol);
      case 'waddle':  return this._vStep(t, o, vol);
      case 'wingbeat': return this._vWing(t, o, vol);
      case 'fish-rise': return this._vPlop(t, o, vol * 0.8, 1.1);
      case 'fish-catch': return this._vCatch(t, o, vol);
      case 'fish-escape': return this._vEscape(t, o, vol);
      case 'chime':   return this._vChime(t, o, vol);
      case 'ripple':  return this._vPlop(t, o, vol * 0.5, 1.4);
      default:        return this._vPlop(t, o, vol * 0.7, 1);
    }
  }

  /** Water breaking. `s` 0.1 … 1.4 scales weight, length and darkness. */
  _vSplash(t, o, vol, s) {
    const str = clamp(s, 0.08, 1.6);
    const dest = this._dest(o, 0.28);
    const jitter = 0.9 + this.rand() * 0.22;

    // The hiss: a bandpass falling from bright spray to a wet gulp.
    const bp = this._filter('bandpass', 2600 * jitter, 0.75);
    const g = this._gain(0.0001);
    const src = this._noise('white', t, 1.1);
    src.connect(g).connect(bp).connect(dest);
    bp.frequency.setValueAtTime(lerp(3400, 2000, str) * jitter, t);
    bp.frequency.exponentialRampToValueAtTime(lerp(700, 320, str) * jitter, t + 0.28 + str * 0.2);
    const hissEnd = this._env(g.gain, t, 0.32 * vol * (0.45 + str * 0.6), 0.006, 0.42 + str * 0.5);
    src.stop(hissEnd + 0.1);

    // The body: the low "ploop" of displaced water.
    const o1 = this._osc('sine', 240, t);
    const g1 = this._gain(0.0001);
    o1.frequency.setValueAtTime(lerp(300, 190, str) * jitter, t);
    o1.frequency.exponentialRampToValueAtTime(lerp(120, 62, str), t + 0.16 + str * 0.1);
    o1.connect(g1).connect(dest);
    const bodyEnd = this._env(g1.gain, t + 0.004, 0.26 * vol * str, 0.006, 0.2 + str * 0.18);
    o1.start(t); o1.stop(bodyEnd + 0.05);

    let end = Math.max(hissEnd, bodyEnd);
    // Droplets raining back down, only for a real splash.
    if (str > 0.35) {
      const drops = 2 + Math.floor(this.rand() * (2 + str * 4));
      for (let i = 0; i < drops; i++) {
        const nt = t + 0.08 + this.rand() * (0.25 + str * 0.4);
        end = Math.max(end, this._drop(dest, nt, 0.06 * vol * (0.5 + this.rand())));
      }
    }
    this._retire(end + 0.4, src, g, bp, o1, g1, dest);
    this._bump(0.1 + str * 0.12);
    return true;
  }

  /** A single droplet ping. */
  _drop(dest, t, level) {
    const f = 900 + this.rand() * 1700;
    const o = this._osc('sine', f, t);
    const g = this._gain(0.0001);
    o.frequency.exponentialRampToValueAtTime(f * (1.5 + this.rand() * 0.9), t + 0.045);
    o.connect(g).connect(dest);
    const end = this._env(g.gain, t, level, 0.003, 0.05);
    o.start(t); o.stop(end + 0.03);
    this._retire(end + 0.15, o, g);
    return end;
  }

  _vDive(t, o, vol) {
    this._vSplash(t, o, vol * 0.85, 0.75);
    const dest = this._dest(o, 0.2);
    // The whoosh of going under: a resonant lowpass diving with you.
    const lp = this._filter('lowpass', 1800, 4.5);
    const g = this._gain(0.0001);
    const src = this._noise('brown', t, 1.2);
    src.connect(g).connect(lp).connect(dest);
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(190, t + 0.55);
    const end = this._env(g.gain, t, 0.4 * vol, 0.04, 0.55, 0.08);
    src.stop(end + 0.1);
    // A gulp of bubbles trailing behind.
    this._vBubbles(t + 0.12, o, vol * 0.5, 6);
    this._retire(end + 0.3, src, g, lp, dest);
    this._bump(0.28);
    return true;
  }

  _vSurface(t, o, vol) {
    this._vSplash(t, o, vol, 0.85);
    const dest = this._dest(o, 0.25);
    // The gasp: a band opening upward, breathy not vocal.
    const bp = this._filter('bandpass', 500, 1.6);
    const g = this._gain(0.0001);
    const src = this._noise('pink', t, 0.7);
    src.connect(g).connect(bp).connect(dest);
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(1700, t + 0.22);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.45);
    let end = this._env(g.gain, t, 0.2 * vol, 0.05, 0.3, 0.06);
    src.stop(end + 0.1);

    // The shake: wing flutter plus a scatter of droplets.
    const sg = this._gain(0.0001);
    const sf = this._filter('bandpass', 900, 0.9);
    const ssrc = this._noise('white', t + 0.18, 0.5);
    const tr = this._trem(17 + this.rand() * 6, 0.55, t + 0.18);
    ssrc.connect(sg).connect(tr.mul).connect(sf).connect(dest);
    const shakeEnd = this._env(sg.gain, t + 0.18, 0.16 * vol, 0.03, 0.3, 0.1);
    tr.lfo.start(t + 0.18); tr.lfo.stop(shakeEnd + 0.05);
    ssrc.stop(shakeEnd + 0.1);
    end = Math.max(end, shakeEnd);
    for (let i = 0; i < 8; i++) {
      end = Math.max(end, this._drop(dest, t + 0.2 + this.rand() * 0.45, 0.05 * vol * (0.5 + this.rand())));
    }
    this._retire(end + 0.4, src, g, bp, ssrc, sg, sf, tr.lfo, tr.d, tr.mul, dest);
    this._bump(0.22);
    return true;
  }

  /**
   * The quack. A buzzy larynx (two detuned saws with a falling pitch) pushed
   * through three formant bandpasses, with a fast rasp on the amplitude — that
   * rasp is what makes it read as a duck rather than a kazoo. Rate ≥ 1.45
   * switches to the duckling peep, which is nearly a pure tone with a rise and
   * a fall, because that is what makes it sound small and sweet.
   */
  _vQuack(t, o, vol, rate) {
    const dest = this._dest(o, 0.3);
    const wobble = 0.94 + this.rand() * 0.12;
    if (rate >= 1.45) {
      // ---- duckling peep -------------------------------------------------
      const f = 900 * rate * wobble;
      const dur = 0.1 + this.rand() * 0.05;
      const osc = this._osc('triangle', f, t);
      const sub = this._osc('sine', f * 0.5, t);
      const sg = this._gain(0.3);
      const g = this._gain(0.0001);
      const bp = this._filter('bandpass', f * 1.7, 1.6);
      osc.frequency.setValueAtTime(f * 0.78, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.16, t + dur * 0.4);
      osc.frequency.exponentialRampToValueAtTime(f * 0.95, t + dur);
      sub.frequency.setValueAtTime(f * 0.4, t);
      sub.frequency.exponentialRampToValueAtTime(f * 0.55, t + dur);
      const vib = this._osc('sine', 38, t);
      const vg = this._gain(f * 0.03);
      vib.connect(vg).connect(osc.frequency);
      osc.connect(g); sub.connect(sg).connect(g);
      g.connect(bp).connect(dest);
      let end = this._env(g.gain, t, 0.2 * vol, 0.01, dur * 0.7, dur * 0.35);
      osc.start(t); sub.start(t); vib.start(t);
      // Peeps come in twos and threes more often than alone.
      if (this.rand() < 0.55) {
        const t2 = t + dur + 0.07 + this.rand() * 0.05;
        const g2end = this._env(g.gain, t2, 0.17 * vol, 0.01, dur * 0.7, dur * 0.3);
        osc.frequency.setValueAtTime(f * 0.8, t2);
        osc.frequency.exponentialRampToValueAtTime(f * 1.2, t2 + dur * 0.4);
        osc.frequency.exponentialRampToValueAtTime(f, t2 + dur);
        end = g2end;
      }
      osc.stop(end + 0.05); sub.stop(end + 0.05); vib.stop(end + 0.05);
      this._retire(end + 0.3, osc, sub, sg, vib, vg, g, bp, dest);
      this._bump(0.1);
      return true;
    }

    // ---- adult quack -----------------------------------------------------
    const f0 = 300 * rate * wobble;
    const syllables = this.rand() < 0.32 ? 2 : 1;
    const larynx = this._gain(1);
    const saw = this._osc('sawtooth', f0, t);
    const saw2 = this._osc('sawtooth', f0 * 1.006, t);
    const s2g = this._gain(0.6);
    const breath = this._noise('white', t, 0.4);
    const bg = this._gain(0.05);
    const bhp = this._filter('highpass', 2200, 0.7);
    saw.connect(larynx); saw2.connect(s2g).connect(larynx);
    breath.connect(bhp).connect(bg).connect(larynx);

    // Formants. F1 sweeps, which gives the quack its "wa" shape.
    const amp = this._gain(0.0001);
    const f1 = this._filter('bandpass', 700, 6);
    const f2 = this._filter('bandpass', 1180 * rate, 8);
    const f3 = this._filter('bandpass', 2500 * rate, 7);
    const g1 = this._gain(1.0), g2 = this._gain(0.55), g3 = this._gain(0.22);
    // The rasp: a fast tremolo after the envelope, so silence stays silent.
    const tr = this._trem(58 + this.rand() * 16, 0.16, t);
    larynx.connect(amp).connect(tr.mul);
    tr.mul.connect(f1).connect(g1).connect(dest);
    tr.mul.connect(f2).connect(g2).connect(dest);
    tr.mul.connect(f3).connect(g3).connect(dest);

    let end = t;
    for (let i = 0; i < syllables; i++) {
      const st = t + i * (0.17 + this.rand() * 0.06);
      const dur = (i === 0 ? 0.17 : 0.13) * (0.85 + this.rand() * 0.35);
      const lvl = 0.24 * vol * (i === 0 ? 1 : 0.72);
      // Pitch falls through the syllable — a rising quack sounds like a toy.
      saw.frequency.setValueAtTime(f0 * 1.3, st);
      saw.frequency.exponentialRampToValueAtTime(f0 * 0.82, st + dur);
      saw2.frequency.setValueAtTime(f0 * 1.31, st);
      saw2.frequency.exponentialRampToValueAtTime(f0 * 0.83, st + dur);
      f1.frequency.setValueAtTime(520 * rate, st);
      f1.frequency.linearRampToValueAtTime(980 * rate, st + dur * 0.45);
      f1.frequency.linearRampToValueAtTime(640 * rate, st + dur);
      end = this._env(amp.gain, st, lvl, 0.009, dur * 0.72, dur * 0.28);
    }
    saw.start(t); saw2.start(t); tr.lfo.start(t);
    saw.stop(end + 0.05); saw2.stop(end + 0.05); tr.lfo.stop(end + 0.05);
    breath.stop(end + 0.05);
    this._retire(end + 0.4, saw, saw2, s2g, breath, bg, bhp, larynx, amp,
      f1, f2, f3, g1, g2, g3, tr.lfo, tr.d, tr.mul, dest);
    this._bump(0.16);
    return true;
  }

  _vBubbles(t, o, vol, count) {
    const dest = this._dest(o, 0.18);
    const n = clamp(Math.round(count * 0.5), 3, 11);
    let end = t;
    for (let i = 0; i < n; i++) {
      const nt = t + this.rand() * 0.55;
      const f = 220 + this.rand() * 700;
      const osc = this._osc('sine', f, nt);
      const g = this._gain(0.0001);
      const bp = this._filter('bandpass', f * 1.6, 3);
      // A bubble's pitch rises as it detaches — that glide is the whole sound.
      osc.frequency.exponentialRampToValueAtTime(f * (1.7 + this.rand() * 1.1), nt + 0.05 + this.rand() * 0.04);
      osc.connect(g).connect(bp).connect(dest);
      const e = this._env(g.gain, nt, 0.1 * vol * (0.5 + this.rand() * 0.8), 0.004, 0.05 + this.rand() * 0.05);
      osc.start(nt); osc.stop(e + 0.03);
      this._retire(e + 0.15, osc, g, bp);
      end = Math.max(end, e);
    }
    // A wash of fizz underneath.
    const fg = this._gain(0.0001);
    const fbp = this._filter('bandpass', 1400, 1.2);
    const fsrc = this._noise('white', t, 0.8);
    fsrc.connect(fg).connect(fbp).connect(dest);
    const fe = this._env(fg.gain, t, 0.05 * vol, 0.05, 0.5, 0.1);
    fsrc.stop(fe + 0.1);
    end = Math.max(end, fe);
    this._retire(end + 0.3, fsrc, fg, fbp, dest);
    return true;
  }

  /** Up-ending to sift the bottom: water sluicing, grit, a few bubbles. */
  _vDabble(t, o, vol) {
    const dest = this._dest(o, 0.3);
    const bp = this._filter('bandpass', 780, 1.8);
    const g = this._gain(0.0001);
    const src = this._noise('pink', t, 2.0);
    src.connect(g).connect(bp).connect(dest);
    // Six irregular sluices rather than one flat wash.
    let end = t;
    g.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 6; i++) {
      const nt = t + i * 0.21 + this.rand() * 0.06;
      const lvl = 0.14 * vol * (0.45 + this.rand() * 0.75);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0005, lvl), nt + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0006, nt + 0.17);
      bp.frequency.setValueAtTime(600 + this.rand() * 900, nt);
      end = nt + 0.2;
    }
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.2);
    src.stop(end + 0.3);
    this._vBubbles(t + 0.25, o, vol * 0.5, 7);
    this._vSplash(t, o, vol * 0.4, 0.25);
    this._retire(end + 0.5, src, g, bp, dest);
    return true;
  }

  /** Preening: dry feather rustle, three quick strokes and a fluff. */
  _vPreen(t, o, vol) {
    const dest = this._dest(o, 0.2);
    const bp = this._filter('bandpass', 4200, 1.4);
    const g = this._gain(0.0001);
    const src = this._noise('white', t, 1.4);
    src.connect(g).connect(bp).connect(dest);
    let end = t;
    for (let i = 0; i < 3; i++) {
      const nt = t + i * (0.18 + this.rand() * 0.08);
      bp.frequency.setValueAtTime(3200 + this.rand() * 2600, nt);
      bp.frequency.exponentialRampToValueAtTime(1800 + this.rand() * 900, nt + 0.14);
      end = this._env(g.gain, nt, 0.1 * vol * (0.6 + this.rand() * 0.6), 0.02, 0.11, 0.03);
    }
    // The fluff at the end: a soft low shuffle.
    const lg = this._gain(0.0001);
    const lp = this._filter('lowpass', 900, 1.1);
    const lsrc = this._noise('pink', end, 0.5);
    lsrc.connect(lg).connect(lp).connect(dest);
    const le = this._env(lg.gain, end + 0.02, 0.08 * vol, 0.05, 0.25, 0.04);
    lsrc.stop(le + 0.1);
    src.stop(le + 0.1);
    this._retire(le + 0.3, src, g, bp, lsrc, lg, lp, dest);
    return true;
  }

  /** One webbed footfall — a damp slap with a little grit under it. */
  _vStep(t, o, vol) {
    const dest = this._dest(o, 0.12);
    const jit = 0.85 + this.rand() * 0.35;
    const lp = this._filter('lowpass', 520 * jit, 2.2);
    const g = this._gain(0.0001);
    const src = this._noise('brown', t, 0.2);
    src.connect(g).connect(lp).connect(dest);
    const end = this._env(g.gain, t, 0.11 * vol, 0.004, 0.075);
    src.stop(end + 0.05);
    // Grit / claw scuff.
    const hg = this._gain(0.0001);
    const hp = this._filter('highpass', 2600, 0.8);
    const hsrc = this._noise('white', t, 0.12);
    hsrc.connect(hg).connect(hp).connect(dest);
    const he = this._env(hg.gain, t + 0.006, 0.035 * vol, 0.003, 0.045);
    hsrc.stop(he + 0.05);
    this._retire(Math.max(end, he) + 0.2, src, g, lp, hsrc, hg, hp, dest);
    return true;
  }

  /** A wingbeat: three whooshes with a thump of displaced air on each. */
  _vWing(t, o, vol) {
    const dest = this._dest(o, 0.3);
    const beats = 3;
    let end = t;
    for (let i = 0; i < beats; i++) {
      const nt = t + i * (0.125 + this.rand() * 0.03);
      const bp = this._filter('bandpass', 300, 1.1);
      const g = this._gain(0.0001);
      const src = this._noise('pink', nt, 0.3);
      src.connect(g).connect(bp).connect(dest);
      bp.frequency.setValueAtTime(240 + this.rand() * 90, nt);
      bp.frequency.exponentialRampToValueAtTime(950 + this.rand() * 350, nt + 0.075);
      bp.frequency.exponentialRampToValueAtTime(380, nt + 0.15);
      const e = this._env(g.gain, nt, 0.2 * vol * (i === 0 ? 1 : 0.75), 0.018, 0.11, 0.02);
      src.stop(e + 0.05);
      // The low body of the beat.
      const oo = this._osc('sine', 95, nt);
      const og = this._gain(0.0001);
      oo.frequency.exponentialRampToValueAtTime(58, nt + 0.11);
      oo.connect(og).connect(dest);
      const oe = this._env(og.gain, nt, 0.09 * vol, 0.01, 0.1);
      oo.start(nt); oo.stop(oe + 0.03);
      this._retire(oe + 0.2, src, g, bp, oo, og);
      end = Math.max(end, e, oe);
    }
    this._retire(end + 0.3, dest);
    this._bump(0.18);
    return true;
  }

  _vPlop(t, o, vol, pitch) {
    const dest = this._dest(o, 0.3);
    const f = 420 * pitch * (0.85 + this.rand() * 0.3);
    const osc = this._osc('sine', f, t);
    const g = this._gain(0.0001);
    osc.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.09);
    osc.connect(g).connect(dest);
    const end = this._env(g.gain, t, 0.14 * vol, 0.004, 0.11);
    osc.start(t); osc.stop(end + 0.03);
    // A tiny tick of surface tension breaking.
    const tg = this._gain(0.0001);
    const bp = this._filter('bandpass', 3200, 2);
    const src = this._noise('white', t, 0.1);
    src.connect(tg).connect(bp).connect(dest);
    const te = this._env(tg.gain, t, 0.05 * vol, 0.002, 0.05);
    src.stop(te + 0.05);
    this._retire(Math.max(end, te) + 0.3, osc, g, src, tg, bp, dest);
    return true;
  }

  _vCatch(t, o, vol) {
    this._vSplash(t, o, vol * 0.7, 0.45);
    this._vChime(t + 0.05, o, vol);
    this._bump(0.55);
    return true;
  }

  _vEscape(t, o, vol) {
    const dest = this._dest(o, 0.25);
    const bp = this._filter('bandpass', 1400, 2.4);
    const g = this._gain(0.0001);
    const src = this._noise('pink', t, 0.5);
    src.connect(g).connect(bp).connect(dest);
    bp.frequency.setValueAtTime(1900, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.3);
    const end = this._env(g.gain, t, 0.16 * vol, 0.01, 0.3, 0.02);
    src.stop(end + 0.1);
    // A deflated little blip.
    const osc = this._osc('sine', 520, t + 0.02);
    const og = this._gain(0.0001);
    osc.frequency.exponentialRampToValueAtTime(230, t + 0.2);
    osc.connect(og).connect(dest);
    const oe = this._env(og.gain, t + 0.02, 0.08 * vol, 0.006, 0.16);
    osc.start(t + 0.02); osc.stop(oe + 0.03);
    this._retire(Math.max(end, oe) + 0.3, src, g, bp, osc, og, dest);
    return true;
  }

  /** The reward: two or three notes of the same pentatonic the score uses. */
  _vChime(t, o, vol) {
    const root = this._root || ROOTS[0];
    const start = 5 + Math.floor(this.rand() * 2);
    const out = o && o.silent ? this.testBus : null;
    for (let i = 0; i < 3; i++) {
      this._pluck(t + i * 0.13, scaleNote(root, start + i * 2) * 4, 0.1 * vol, out);
    }
    this._bump(0.45);
    return true;
  }

  /* --------------------------------------------------------------- wiring */

  _bindEvents() {
    const { events, EVENTS } = this.ctx;
    if (!events || !EVENTS) return;
    const on = (type, fn) => this._offs.push(events.on(type, fn));

    on(EVENTS.SFX, (p) => {
      if (!p || !p.name) return;
      this.play(p.name, p);
    });
    on(EVENTS.SPLASH, (p) => {
      if (!p) return;
      const s = p.strength != null ? p.strength : 0.6;
      if (s < 0.06) return;
      this.play('splash', { position: p.position, volume: clamp(0.35 + s * 0.7, 0.1, 1.3), strength: s });
    });
    on(EVENTS.RIPPLE, (p) => {
      if (!p || (p.strength || 0) < 0.5) return;
      this.play('ripple', { position: p.position, volume: 0.35 });
    });
    // DIVE / SURFACE / QUACK are emitted alongside an SFX event by the player
    // and the family — parked for a frame, see _ifNotAlready below.
    on(EVENTS.DIVE, (p) => this._ifNotAlready('dive', p, 0.9));
    on(EVENTS.SURFACE, (p) => this._ifNotAlready('surface', p, 0.8));
    on(EVENTS.QUACK, (p) => this._ifNotAlready('quack', p, 0.9, p && p.pitch));
    on(EVENTS.BUBBLES, (p) => {
      if (!p) return;
      this.play('bubbles', { position: p.position, volume: 0.6, count: p.count || 8 });
    });
    on(EVENTS.FISH_CAUGHT, (p) => this.play('fish-catch', { position: p?.position, volume: 0.9 }));
    on(EVENTS.QUEST_COMPLETED, () => { this._bump(1); this.play('chime', { volume: 0.9 }); });
    on(EVENTS.GAME_ENDED, () => { this._bump(0.8); });
    on(EVENTS.SHAKE, (p) => this._bump(clamp((p?.strength || 0) * 0.5, 0, 0.5)));
  }

  /**
   * DIVE / SURFACE / QUACK are emitted *before* the matching SFX event by both
   * the player and the family, and the SFX payload is the richer one (it
   * carries `rate`, which is what tells a duckling peep from a drake). So park
   * the bare event for a frame and only voice it if no SFX arrived.
   */
  _ifNotAlready(name, p, vol, pitch) {
    this._deferred[name] = { position: p && p.position, volume: vol, rate: pitch || 1 };
  }

  _flushDeferred(t) {
    for (let i = 0; i < DEFERRED.length; i++) {
      const name = DEFERRED[i];
      const d = this._deferred[name];
      if (!d) continue;
      this._deferred[name] = null;
      if (t - (this._lastEvent[name] || -1) < 0.25) continue;   // SFX covered it
      this.play(name, d);
    }
  }

  /** Nudge the music's sense that something is happening. */
  _bump(amount) {
    this.intensity = clamp(this.intensity + amount, 0, 1.2);
  }

  /* ---------------------------------------------------------------- update */

  update(dt, elapsed) {
    if (!this.ready) return;
    if (!this.running) {
      // Chrome can flip the context to running without firing statechange in
      // some embeddings; poll cheaply until it does.
      if (this.ac && this.ac.state === 'running') this._onRunning();
      return;
    }
    const t = this._now();

    // --- retire finished voices (swap-pop, no allocation) ------------------
    for (let i = this._retired.length - 1; i >= 0; i--) {
      const r = this._retired[i];
      if (t < r.t) continue;
      const nodes = r.n;
      for (let j = 0; j < nodes.length; j++) {
        try { nodes[j].disconnect(); } catch (e) { /* already gone */ }
      }
      this._retired[i] = this._retired[this._retired.length - 1];
      this._retired.pop();
    }
    this.stats.voicesActive = this._retired.length;

    this._flushDeferred(t);
    this._updateListener();

    // --- world sampling, 10 Hz ---------------------------------------------
    this._envAcc += dt;
    if (this._envAcc >= 0.1) {
      this._sampleWorld(this._envAcc);
      this._envAcc = 0;
    }

    // --- underwater crossfade ----------------------------------------------
    this._updateUnderwater(dt);

    // --- footsteps ----------------------------------------------------------
    this._updateSteps(dt);

    // --- schedulers ---------------------------------------------------------
    this._scheduleAmbientEvents(t);
    this._scheduleMusic(t);

    // Music intensity decays back toward silence. The bus level only needs
    // touching a few times a second — it glides over seconds anyway.
    this.intensity *= Math.exp(-dt / 9);
    this._musicAcc += dt;
    if (this._musicAcc >= 0.25) {
      this._musicAcc = 0;
      if (this.musicEnabled) {
        const target = (0.05 + 0.13 * clamp(this.intensity, 0, 1)) * (1 - 0.4 * this.underwater);
        this.musicBus.gain.setTargetAtTime(target, t, 2.2);
      } else {
        this.musicBus.gain.setTargetAtTime(0.0001, t, 0.8);
      }
    }
  }

  _updateListener() {
    const cam = this.ctx.engine?.camera || this.ctx.camera;
    const l = this.ac.listener;
    if (!cam || !cam.matrixWorld) return;
    const e = cam.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    this._listenerX = px; this.listenerY = py; this._listenerZ = pz;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      if (l.setPosition) l.setPosition(px, py, pz);
      if (l.setOrientation) l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Everything the beds track. Runs at 10 Hz, allocates nothing. */
  _sampleWorld() {
    const ctx = this.ctx;
    const river = ctx.river;
    const player = ctx.player || ctx.get?.('player');
    const t = this._now();

    const px = player?.position?.x ?? this._listenerX ?? 0;
    const py = player?.position?.y ?? 0;
    const pz = player?.position?.z ?? this._listenerZ ?? 0;
    this._scratch.set(px, py, pz);

    let flowNorm = 0, rough = 0, near = 0, prox = 1, pan = 0;
    if (river) {
      river.toRiver(this._scratch, this._rc);
      const rc = this._rc;
      river.flowAt(rc.s, rc.u, this._flow);
      this.flowSpeed = this._flow.length();
      const depth = Math.max(0.02, river.depth(rc.s, rc.u));

      // Fastest water within ~24 m, and which side it is on — this is what
      // makes walking toward a riffle actually sound like approaching one.
      let fastest = this.flowSpeed;
      let left = 0, right = 0;
      for (let i = 0; i < 4; i++) {
        const ds = (i < 2 ? 1 : -1) * 14;
        const du = clamp(rc.u + (i % 2 ? 0.7 : -0.7), -0.98, 0.98);
        const ss = clamp(rc.s + ds, 0, river.length);
        river.flowAt(ss, du, this._flowB);
        const sp = this._flowB.length();
        const shallow = 1 / (0.6 + Math.max(0.05, river.depth(ss, du)));
        const r = sp * shallow;
        if (r > fastest) fastest = r;
        if (du < rc.u) left = Math.max(left, r); else right = Math.max(right, r);
      }
      this.flowNear = fastest;
      flowNorm = clamp(this.flowSpeed / 2.4, 0, 1);
      rough = clamp((fastest * (1.1 / (0.5 + depth))) / 2.2, 0, 1);
      pan = clamp((right - left) * 0.45, -0.6, 0.6);

      // Rocks breaking the surface make the loudest, brightest water.
      const rocks = ctx.terrain?.rocks;
      if (Array.isArray(rocks) && rocks.length) {
        let best = 1e9;
        const step = rocks.length > 260 ? Math.ceil(rocks.length / 260) : 1;
        const off = this._rockOff = ((this._rockOff || 0) + 1) % step;
        for (let i = off; i < rocks.length; i += step) {
          const r = rocks[i];
          const rp = r.position || r;
          if (rp.x === undefined) continue;
          const dx = rp.x - px, dz = rp.z - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
        near = clamp(1 - Math.sqrt(best) / 16, 0, 1);
      }
      this.rockNear = near;
      this.roughness = rough;

      // Off the water entirely? The river recedes behind you.
      const overU = Math.abs(this._rc.u);
      prox = clamp(1.25 - Math.max(0, overU - 0.9) * 1.1, 0.12, 1);
      this.waterProximity = prox;

      // Reeds and cover.
      const veg = ctx.vegetation || ctx.get?.('vegetation');
      this.windAmount = veg?.windStrength ?? (0.85 + 0.25 * Math.sin(t * 0.09));
      this.reedCover = veg?.coverAt ? clamp(veg.coverAt(rc.s, rc.u), 0, 1) : 0.35;
    }

    const A = this._ambience;
    if (!A.flowLow) return;
    const bright = clamp(0.35 * flowNorm + 0.65 * rough, 0, 1);
    const dryAbove = 1 - 0.5 * clamp((this.listenerY - 1.6) / 7, 0, 1);   // fades as the camera lifts
    const w = prox * dryAbove;

    A.flowLow.gain.setTargetAtTime(clamp((0.09 + 0.20 * flowNorm) * w, 0.0001, 0.5), t, 0.4);
    A.flowMid.gain.setTargetAtTime(clamp((0.035 + 0.16 * flowNorm + 0.1 * rough) * w, 0.0001, 0.5), t, 0.4);
    A.flowHiss.gain.setTargetAtTime(clamp((0.006 + 0.075 * rough + 0.06 * near * rough) * w, 0.0001, 0.4), t, 0.5);
    A.flowMidFilter.frequency.setTargetAtTime(560 + 1100 * bright, t, 0.6);
    A.flowHissFilter.frequency.setTargetAtTime(2100 + 1800 * bright, t, 0.8);
    if (A.flowPan) A.flowPan.pan.setTargetAtTime(pan, t, 0.9);

    const wind = clamp(this.windAmount / 1.2, 0, 1.2);
    A.wind.gain.setTargetAtTime(clamp(0.035 + 0.055 * wind, 0.0001, 0.3), t, 1.2);
    A.reed.gain.setTargetAtTime(clamp((0.012 + 0.075 * wind) * (0.3 + 0.7 * this.reedCover), 0.0001, 0.3), t, 1.0);
    A.gustDepthA.gain.setTargetAtTime(0.012 + 0.03 * wind, t, 1.5);

    const tod = clamp(ctx.settings?.timeOfDay ?? 0.3, 0, 1);
    const dusk = Math.exp(-Math.pow((tod - 0.79) / 0.11, 2)) + Math.exp(-Math.pow((tod - 0.18) / 0.09, 2)) * 0.4;
    const nightBed = (tod > 0.84 || tod < 0.12) ? 0.5 : 0;
    A.insect.gain.setTargetAtTime(clamp((dusk * 0.02 + nightBed * 0.012), 0.0001, 0.06), t, 2.5);
  }

  /**
   * The dive. One filter glide, ~0.35 s, taking the reverb, the low shelf and
   * the bubbly bed with it. The ambience keeps playing behind the filter, which
   * is why it sounds like the world is still there and you are not.
   */
  _updateUnderwater(dt) {
    const ctx = this.ctx;
    const rig = ctx.get?.('camera');
    // Ears are at the camera, but the player's own state is the contract.
    const camUnder = rig?.underwater ?? rig?.camera?.isUnderwater;
    const playerUnder = ctx.player?.submerged ?? false;
    const want = (camUnder != null ? (camUnder || playerUnder) : playerUnder) ? 1 : 0;

    // ~0.35 s to 95%: tau = 0.35 / 3 ≈ 0.117.
    const k = 1 - Math.exp(-dt / 0.117);
    this.underwater += (want - this.underwater) * k;
    if (this.underwater < 0.0005) this.underwater = 0;
    if (this.underwater > 0.9995) this.underwater = 1;

    const uw = this.underwater;
    const depth = ctx.player?.depthBelow || 0;
    this.depth = depth;
    const t = this._now();

    if (this._lastUw === undefined) this._lastUw = -1;
    // Only touch the params while they are actually moving, or when depth
    // changes enough to matter — this keeps the audio thread quiet.
    if (Math.abs(uw - this._lastUw) > 0.002 || (uw > 0.02 && Math.abs(depth - (this._lastDepth || 0)) > 0.25)) {
      this._lastUw = uw;
      this._lastDepth = depth;
      // Deeper is darker: 20 kHz dry, 340 Hz just under, 165 Hz at 6 m. The
      // glide is geometric, not linear — a linear sweep spends its first half
      // between 20 kHz and 10 kHz, which is inaudible, and then slams shut.
      const dark = lerp(340, 165, clamp(depth / 6, 0, 1));
      const target = 20000 * Math.pow(dark / 20000, uw);
      this.muffle.frequency.setTargetAtTime(target, t, 0.06);
      this.muffle.Q.setTargetAtTime(lerp(0.4, 1.1, uw), t, 0.1);
      this.lowShelf.gain.setTargetAtTime(lerp(0, 7.5, uw), t, 0.1);
      // Water is a better conductor and the space closes in.
      this.reverbReturn.gain.setTargetAtTime(lerp(0.5, 0.9, uw), t, 0.12);
      this.uwBus.gain.setTargetAtTime(Math.max(0.0001, lerp(0, 0.5, uw)), t, 0.12);
      this.ambienceBus.gain.setTargetAtTime(lerp(0.55, 0.28, uw), t, 0.12);
      const A = this._ambience;
      if (A.uwHiss) A.uwHiss.gain.setTargetAtTime(lerp(0.12, 0.2, uw), t, 0.3);
    }

    // Rising bubbles while actually under, at a lazy random rate.
    if (uw > 0.6) {
      this._bubbleAcc = (this._bubbleAcc || 0) + dt;
      if (this._bubbleAcc > 1.2 + this.rand() * 2.2) {
        this._bubbleAcc = 0;
        const dest = this._gain(0.35);
        dest.connect(this.uwBus);
        const nt = this._now() + 0.01;
        const n = 2 + Math.floor(this.rand() * 3);
        let end = nt;
        for (let i = 0; i < n; i++) {
          const bt = nt + this.rand() * 0.5;
          const f = 140 + this.rand() * 380;
          const osc = this._osc('sine', f, bt);
          const g = this._gain(0.0001);
          osc.frequency.exponentialRampToValueAtTime(f * 2.1, bt + 0.07);
          osc.connect(g).connect(dest);
          const e = this._env(g.gain, bt, 0.12, 0.004, 0.07);
          osc.start(bt); osc.stop(e + 0.03);
          this._retire(e + 0.15, osc, g);
          end = Math.max(end, e);
        }
        this._retire(end + 0.3, dest);
      }
    }
  }

  _updateSteps(dt) {
    const p = this.ctx.player;
    if (!p || !p.grounded || p.submerged || p.airborne) { this._stepPhase = 0; return; }
    const speed = p.speed || 0;
    if (speed < 0.22) { this._stepPhase = 0; return; }
    this._stepPhase += dt * (1.7 + speed * 1.5);
    if (this._stepPhase >= 1) {
      this._stepPhase -= 1;
      this._stepFoot ^= 1;
      this._pos.copy(p.position);
      this.play('waddle', {
        position: this._pos,
        volume: clamp(0.25 + speed * 0.2, 0.2, 0.7),
        rate: this._stepFoot ? 1.06 : 0.94,
      });
    }
  }

  /* ------------------------------------------------------------------- API */

  /** 0..1. Persisted so the HUD slider survives a reload. */
  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    try { window.localStorage?.setItem('duck.audio.volume', String(this.volume)); } catch (e) {}
    this._applyMaster();
    return this.volume;
  }

  mute(on = true) {
    this.muted = !!on;
    try { window.localStorage?.setItem('duck.audio.muted', this.muted ? '1' : '0'); } catch (e) {}
    this._applyMaster();
    return this.muted;
  }

  toggleMute() { return this.mute(!this.muted); }

  setMusicEnabled(on = true) { this.musicEnabled = !!on; return this.musicEnabled; }

  _applyMaster() {
    if (!this.masterGain) return;
    this._ramp(this.masterGain.gain, this._masterTarget(), 0.25);
  }

  get state() { return this.ac ? this.ac.state : 'unavailable'; }

  /**
   * Node-graph summary plus a construction check of every voice. The voices are
   * built into a silent bus that is not connected to the destination, so this
   * is safe to call at any time — including from the capture harness.
   */
  selfTest() {
    const out = {
      available: this.available,
      ready: this.ready,
      running: this.running,
      state: this.state,
      blockedReason: this.blockedReason || null,
      sampleRate: this.ac ? this.ac.sampleRate : 0,
      volume: this.volume,
      muted: this.muted,
      underwater: Number(this.underwater.toFixed(3)),
      world: {
        flowSpeed: Number((this.flowSpeed || 0).toFixed(2)),
        roughness: Number((this.roughness || 0).toFixed(2)),
        rockNear: Number((this.rockNear || 0).toFixed(2)),
        windAmount: Number((this.windAmount || 0).toFixed(2)),
        reedCover: Number((this.reedCover || 0).toFixed(2)),
        waterProximity: Number((this.waterProximity || 0).toFixed(2)),
        intensity: Number(this.intensity.toFixed(2)),
      },
      graph: null,
      ambience: {},
      music: { padVoices: this._padVoices.length, enabled: this.musicEnabled, root: this._root || 0 },
      voices: {},
      activeVoices: this._retired.length,
      spawned: this.stats.voicesSpawned,
      errors: [],
    };
    if (!this.ready) return out;

    out.graph = {
      master: `GainNode(${this.masterGain.gain.value.toFixed(3)})`,
      limiter: `DynamicsCompressor(th=${this.limiter.threshold.value}, ratio=${this.limiter.ratio.value})`,
      muffle: `BiquadFilter(lowpass, ${Math.round(this.muffle.frequency.value)}Hz, Q=${this.muffle.Q.value.toFixed(2)})`,
      lowShelf: `BiquadFilter(lowshelf, ${Math.round(this.lowShelf.frequency.value)}Hz, ${this.lowShelf.gain.value.toFixed(1)}dB)`,
      convolver: this.convolver.buffer
        ? `Convolver(${this.convolver.buffer.duration.toFixed(2)}s, ${this.convolver.buffer.numberOfChannels}ch)`
        : 'Convolver(NO IMPULSE)',
      buses: {
        ambience: this.ambienceBus.gain.value.toFixed(3),
        sfx: this.sfxBus.gain.value.toFixed(3),
        music: this.musicBus.gain.value.toFixed(3),
        underwater: this.uwBus.gain.value.toFixed(3),
        reverbReturn: this.reverbReturn.gain.value.toFixed(3),
      },
      noiseBuffers: Object.keys(this.buffers || {}).map(
        (k) => `${k}:${this.buffers[k].duration.toFixed(1)}s`,
      ),
    };
    for (const k of Object.keys(this._ambience)) {
      const n = this._ambience[k];
      // Filters first: a BiquadFilterNode also has a `.gain` param, so testing
      // for gain first reports every filter as 0.
      out.ambience[k] = !n ? 'missing'
        : n.frequency ? `${n.type || 'osc'} ${Math.round(n.frequency.value)}Hz`
          : n.gain ? Number(n.gain.value.toFixed(4))
            : n.constructor.name;
    }

    // Construct every voice into the silent bus.
    if (this.running) {
      const t = this._now() + 0.01;
      for (const name of SFX_NAMES) {
        try {
          const ok = this._synth(name, t, { silent: true, volume: 0.001, position: null, count: 6 });
          out.voices[name] = !!ok;
        } catch (err) {
          out.voices[name] = false;
          out.errors.push(`${name}: ${err.message}`);
        }
      }
    } else {
      for (const name of SFX_NAMES) out.voices[name] = 'not-running';
      out.errors.push('context is not running: no gesture yet, or autoplay blocked');
    }
    return out;
  }

  /* ----------------------------------------------------------------- teardown */

  dispose() {
    for (const off of this._offs) { try { off(); } catch (e) {} }
    this._offs.length = 0;
    if (this._gestureHandler) {
      for (const t of ['pointerdown', 'keydown', 'touchstart', 'mousedown', 'wheel']) {
        window.removeEventListener(t, this._gestureHandler);
      }
      this._gestureHandler = null;
    }
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
    const stopAll = (obj) => {
      for (const k of Object.keys(obj || {})) {
        const n = obj[k];
        try { n.stop?.(); } catch (e) {}
        try { n.disconnect?.(); } catch (e) {}
      }
    };
    stopAll(this._ambience);
    for (const v of this._padVoices) {
      try { v.a.stop(); v.b.stop(); } catch (e) {}
      try { v.a.disconnect(); v.b.disconnect(); v.g.disconnect(); } catch (e) {}
    }
    this._padVoices.length = 0;
    for (const r of this._retired) {
      for (const n of r.n) { try { n.disconnect(); } catch (e) {} }
    }
    this._retired.length = 0;
    this.running = false;
    this.ready = false;
    try { this.ac?.close?.(); } catch (e) {}
    this.ac = null;
  }
}
