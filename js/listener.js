// Écoute du piano au micro.
// Principe : spectre FFT → pour chaque touche (A0..C8), une « saillance » = moyenne pondérée
// du niveau (dB au-dessus du bruit de fond) de ses 6 premiers harmoniques.
// Une note est « attaquée » quand sa saillance dépasse le seuil ET vient de monter brusquement.
// En mode attente on sait quelles notes on attend : on vérifie surtout celles-là,
// ce qui est bien plus fiable qu'une transcription aveugle (surtout pour les accords).

const LO = 21, HI = 108;
const SHORT = 4096;       // taille de la fenêtre courte (attaques)
const WEIGHTS = [1, 0.9, 0.7, 0.5, 0.35, 0.25];
const HIST = 18;          // ~300 ms d'historique à 60 i/s pour détecter les montées
const RISE_DB = 7;        // montée minimale pour compter une attaque
const REFRACTORY = 180;   // ms : pas deux attaques de la même touche plus rapprochées
const GHOSTS = [12, 19, 24, 28, 31, 34, 36]; // écarts (demi-tons) des harmoniques 2 à 8
const REL_DB = 16;        // écart max avec la note la plus forte

export const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
const NAMES = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'Si♭', 'Si'];
export const noteName = (m, octave = true) => NAMES[m % 12] + (octave ? Math.floor(m / 12) - 1 : '');

// Sensibilité 1..10 → seuil en dB de saillance
export const sensToThreshold = s => 21 - s * 1.5;

export class Listener {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.threshold = sensToThreshold(5);
    this.onFrame = null;      // (info) => void, appelé à chaque image
    this.onOnset = null;      // (midi, salience) => void
    this.sal = new Float32Array(HI + 1);
    this.h1 = new Float32Array(HI + 1);   // niveau de la fondamentale
    this.h2 = new Float32Array(HI + 1);   // niveau de l'harmonique 2
    this.raw = new Float32Array(HI + 1);  // niveau absolu (dB) de la fondamentale, pour suivre les attaques
    this.recent = [];                     // attaques récentes [{ m, t }]
    this.hist = Array.from({ length: HI + 1 }, () => new Float32Array(HIST));
    this.histF = Array.from({ length: HI + 1 }, () => new Float32Array(HIST)); // idem pour la fondamentale
    this.histPos = 0;
    this.lastOnset = new Float64Array(HI + 1);
    this.level = 0;
    this.floorDb = -100;
    this.frameMax = 0;
    this._frame = 0;
  }

  // sourceFactory(ctx) → AudioNode : permet de tester avec un son synthétique.
  async start(sourceFactory) {
    if (this.running) return;
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    let source;
    if (sourceFactory) {
      source = sourceFactory(this.ctx);
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      source = this.ctx.createMediaStreamSource(this.stream);
    }
    this.source = source;
    const an = this.ctx.createAnalyser();
    an.fftSize = 16384;
    an.smoothingTimeConstant = 0;
    an.minDecibels = -120;
    an.maxDecibels = 0;
    source.connect(an);
    // 2e analyse, fenêtre courte (~85 ms) : moins précise en hauteur mais bien plus
    // réactive dans le temps → sert à repérer les attaques (surtout les notes répétées).
    const an2 = this.ctx.createAnalyser();
    an2.fftSize = SHORT;
    an2.smoothingTimeConstant = 0;
    an2.minDecibels = -120;
    an2.maxDecibels = 0;
    source.connect(an2);
    this.analyser2 = an2;
    this.spec2 = new Float32Array(an2.frequencyBinCount);
    // certains navigateurs (Safari) ne font tourner l'analyseur que s'il est relié à la sortie :
    // on le branche sur un gain à 0 (aucun son émis).
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    an.connect(this.mute).connect(this.ctx.destination);
    an2.connect(this.mute);
    this.analyser = an;
    this.spec = new Float32Array(an.frequencyBinCount);
    this.time = new Float32Array(2048);
    this.binHz = this.ctx.sampleRate / an.fftSize;
    this._prepareBins();
    this.running = true;
    this._frame = 0;
    const loop = () => {
      if (!this.running) return;
      this._process();
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    for (const n of [this.source, this.analyser, this.analyser2, this.mute]) {
      if (n) try { n.disconnect(); } catch { /* déjà déconnecté */ }
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.source = null;
  }

  // Mode hors-ligne (tests) : pas d'AudioContext, on remplit spec/time soi-même.
  setupOffline(sampleRate, fftSize = 16384) {
    this.sampleRate = sampleRate;
    this.spec = new Float32Array(fftSize / 2);
    this.spec2 = new Float32Array(SHORT / 2);
    this.time = new Float32Array(2048);
    this.binHz = sampleRate / fftSize;
    this._prepareBins();
    this.running = true;
    this._frame = 0;
  }

  // Pré-calcul des fenêtres de bins pour chaque harmonique de chaque touche
  _prepareBins() {
    const nyq = (this.sampleRate || this.ctx.sampleRate) / 2;
    const tol = Math.pow(2, 0.4 / 12); // ±40 cents
    this.bins = [];
    for (let m = 0; m <= HI; m++) {
      const list = [];
      if (m >= LO) {
        const f = midiToFreq(m);
        for (let h = 1; h <= WEIGHTS.length; h++) {
          const fh = f * h;
          if (fh > nyq * 0.9 || fh > 9000) break;
          const a = Math.max(1, Math.floor(fh / tol / this.binHz));
          const b = Math.max(a, Math.ceil(fh * tol / this.binHz));
          list.push([a, b, WEIGHTS[h - 1]]);
        }
      }
      this.bins.push(list);
    }
    // Fenêtres courtes : harmoniques 1 à 3 (les graves n'ont presque pas de fondamentale)
    const binHz2 = (this.sampleRate || this.ctx.sampleRate) / SHORT;
    this.bins2 = [];
    for (let m = 0; m <= HI; m++) {
      const list = [];
      if (m >= LO) {
        const f = midiToFreq(m);
        for (let h = 1; h <= 3; h++) {
          const c = f * h / binHz2;
          if (f * h > nyq * 0.9) break;
          if (m >= 45 && h > 1) break; // au-dessus de La2 la fondamentale suffit
          list.push([Math.max(1, Math.floor(c / tol)), Math.ceil(c * tol)]);
        }
      }
      this.bins2.push(list);
    }
    // Bruit de fond par bande de 1/3 d'octave (au moins 32 bins par bande)
    this.bands = [];
    for (let k = 0; ; k++) {
      const fc = 25 * Math.pow(2, k / 3);
      if (fc > 10000 || fc > nyq * 0.95) break;
      const c = fc / this.binHz;
      let a = Math.floor(c / Math.pow(2, 1 / 6)), b = Math.ceil(c * Math.pow(2, 1 / 6));
      if (b - a < 32) { const mid = Math.round(c); a = Math.max(1, mid - 16); b = mid + 16; }
      this.bands.push([a, b]);
    }
    this.bandFloor = new Float32Array(this.bands.length).fill(-140);
    this.bandOf = f => Math.max(0, Math.min(this.bands.length - 1, Math.round(3 * Math.log2(f / 25))));
    for (let m = LO; m <= HI; m++) {
      const f = midiToFreq(m);
      this.bins[m].forEach((w, i) => w.push(this.bandOf(f * (i + 1))));
    }
    this.floorA = Math.floor(60 / this.binHz);
    this.floorB = Math.floor(5000 / this.binHz);
  }

  _updateFloor() {
    const sp = this.spec;
    let sum = 0, n = 0;
    for (let k = 0; k < this.bands.length; k++) {
      const [a, b] = this.bands[k];
      const arr = Array.from(sp.subarray(a, b + 1)).filter(Number.isFinite).sort((x, y) => x - y);
      // 30e centile : le « fond » de la bande, peu sensible aux pics des notes
      const v = arr.length ? arr[Math.floor(arr.length * 0.3)] : -140;
      this.bandFloor[k] = v;
      sum += v; n++;
    }
    this.floorDb = n ? sum / n : -140;
  }

  // Pic dans la fenêtre [a, b] — seulement s'il s'agit d'un vrai sommet du spectre.
  // Si le maximum est au bord et que le spectre continue de monter à l'extérieur,
  // on est sur la pente d'une note voisine : ça ne compte pas.
  _peak(a, b) {
    const sp = this.spec;
    let p = -Infinity, at = a;
    for (let i = a; i <= b; i++) if (sp[i] > p) { p = sp[i]; at = i; }
    if (at === a && sp[a - 1] > p) return -Infinity;
    if (at === b && sp[b + 1] > p) return -Infinity;
    return p;
  }

  _process() {
    const an = this.analyser;
    an.getFloatFrequencyData(this.spec);
    an.getFloatTimeDomainData(this.time);
    this.analyser2.getFloatFrequencyData(this.spec2);
    this.analyze(performance.now());
  }

  // Analyse de this.spec / this.time (séparée pour pouvoir être testée hors-ligne)
  analyze(now) {
    let rms = 0;
    for (let i = 0; i < this.time.length; i++) rms += this.time[i] * this.time[i];
    this.level = Math.sqrt(rms / this.time.length);

    // Bruit de fond par bande (recalculé une image sur 2)
    if (this._frame++ % 2 === 0) this._updateFloor();
    const bf = this.bandFloor;
    this.histPos = (this.histPos + 1) % HIST;

    for (let m = LO; m <= HI; m++) {
      let s = 0, w = 0, r1 = -140, r2 = -140;
      const list = this.bins[m];
      this.h1[m] = 0;
      for (let k = 0; k < list.length; k++) {
        const [a, b, wt, band] = list[k];
        const pk = Math.max(this._peak(a, b), bf[band]); // pas de vrai pic → niveau du fond
        const d = Math.min(70, pk - bf[band]);
        if (k === 0) { this.h1[m] = d; r1 = pk; }
        if (k === 1) { this.h2[m] = d; r2 = pk; }
        s += d * wt; w += wt;
      }
      const v = w ? s / w : 0;
      this.sal[m] = v;
      this.hist[m][this.histPos] = v;
      let rs = -140;
      for (const [a2, b2] of this.bins2[m]) for (let i = a2; i <= b2; i++) if (this.spec2[i] > rs) rs = this.spec2[i];
      this.raw[m] = rs;
      this.histF[m][this.histPos] = this.raw[m];
    }

    let mx = 0;
    for (let m = LO; m <= HI; m++) if (this.sal[m] > mx) mx = this.sal[m];
    this.frameMax = mx;

    // Attaques détectées « à l'aveugle » (pour afficher les fausses notes)
    const onsets = [];
    const T = this.dynThreshold();
    for (let m = LO; m <= HI; m++) {
      const v = this.sal[m];
      if (v < T) continue;
      if (v < this.sal[m - 1] || v < (this.sal[m + 1] || 0)) continue;
      if (!this._fundamentalOk(m)) continue;
      if (this.rise(m) < RISE_DB || this.riseF(m) < RISE_DB * 0.7) continue;
      onsets.push(m);
    }
    // Supprime les harmoniques fantômes (octave, quinte+octave…) d'une note plus grave,
    // attaquée dans la même image ou juste avant.
    this.recent = this.recent.filter(r => now - r.t < 250);
    const lower = [...onsets, ...this.recent.map(r => r.m)];
    const kept = onsets.filter(m => !lower.some(o => GHOSTS.includes(m - o))
      // …ou une note plus grave déjà présente et au moins aussi forte
      && !GHOSTS.some(g => m - g >= LO && this.sal[m - g] >= Math.max(T, this.sal[m] - 6) && this._fundamentalOk(m - g)));
    if (this._frame < HIST + 4) return this.onFrame && this.onFrame({ level: this.level, kept: [], now }); // chauffe
    for (const m of kept) {
      if (now - this.lastOnset[m] < REFRACTORY) continue;
      this.lastOnset[m] = now;
      this.recent.push({ m, t: now });
      this.onOnset && this.onOnset(m, this.sal[m]);
    }
    this.onFrame && this.onFrame({ level: this.level, kept, now });
  }

  // Seuil absolu (sensibilité) ET relatif : une note doit être à moins de REL_DB
  // de la note la plus forte du moment (sinon c'est une résonance / un débordement).
  dynThreshold(slack = 0) {
    return Math.max(this.threshold, this.frameMax - REL_DB - slack);
  }

  // La fondamentale (ou l'harmonique 2 dans les graves) doit être présente,
  // sinon c'est souvent une « sous-octave » fantôme.
  _fundamentalOk(m) {
    const T = this.threshold;
    return m >= 45 ? this.h1[m] > T * 0.6 : Math.max(this.h1[m], this.h2[m]) > T * 0.6;
  }

  // Montée de saillance sur ~300 ms (dB)
  rise(m) {
    const h = this.hist[m];
    let min = Infinity;
    for (let i = 0; i < HIST; i++) if (i !== this.histPos && h[i] < min) min = h[i];
    return this.sal[m] - min;
  }

  // Niveau de la fondamentale (harmonique 2 dans les graves, où la fondamentale est faible)
  fund(m) { return m >= 45 ? this.h1[m] : Math.max(this.h1[m], this.h2[m]); }

  riseF(m) {
    const h = this.histF[m];
    let min = Infinity;
    for (let i = 0; i < HIST; i++) if (i !== this.histPos && h[i] < min) min = h[i];
    return this.raw[m] - min;
  }

  // Minimum récent (~300 ms) de la fondamentale d'une touche
  minRecent(m) {
    const h = this.histF[m];
    let min = Infinity;
    for (let i = 0; i < HIST; i++) if (h[i] < min) min = h[i];
    return min;
  }

  // Test ciblé pour une note attendue : la touche est forte ET sa fondamentale a monté
  // d'au moins RISE_DB depuis son creux (valley) → vraie attaque, même pour une note répétée.
  // (On suit la fondamentale et pas la saillance globale : dans un accord, les harmoniques
  // d'une autre note peuvent tomber sur celles de la note attendue.)
  isStruck(m, valley, rise = RISE_DB) {
    if (m < LO || m > HI) return false;
    if (this.sal[m] < Math.max(this.threshold * 0.85, this.dynThreshold(4)) || !this._fundamentalOk(m)) return false;
    return this.raw[m] - valley >= rise;
  }

  // Notes présentes en ce moment (pour l'écran de test)
  present() {
    const T = this.dynThreshold(), out = [];
    for (let m = LO; m <= HI; m++) {
      const v = this.sal[m];
      if (v < T || v < this.sal[m - 1] || v < (this.sal[m + 1] || 0) || !this._fundamentalOk(m)) continue;
      out.push(m);
    }
    return out.filter(m => !out.some(o => o < m && [12, 19, 24, 28, 31].includes(m - o) && this.sal[o] > this.sal[m] * 0.6));
  }

  // Note isolée la plus présente (pour l'écran de test)
  loudest() {
    let best = -1, bv = this.dynThreshold();
    for (let m = LO; m <= HI; m++) {
      if (this.sal[m] > bv && this._fundamentalOk(m)) { bv = this.sal[m]; best = m; }
    }
    // si l'octave inférieure est aussi forte, c'est probablement elle
    while (best - 12 >= LO && this.sal[best - 12] > bv * 0.8 && this._fundamentalOk(best - 12)) best -= 12;
    return best;
  }
}

export const createListener = () => new Listener();
