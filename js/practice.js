// Mode attente : la partition avance quand les bonnes notes sont jouées.
import { noteName } from './listener.js';

const HARMONIC = [12, 19, 24, 28, 31, 36, -12];
const SETTLE_MS = 90;  // délai après un changement d'étape avant d'écouter une nouvelle frappe
const REP_RISE_DB = 4; // note répétée : remontée suffisante (le son précédent n'est pas éteint)

export class Practice {
  constructor({ keyboard, sheet, roll, listener, onProgress, onDone }) {
    Object.assign(this, { keyboard, sheet, roll, listener, onProgress, onDone });
    this.steps = [];
    this.hand = 'both';
    this.tolerance = 'tolerant';
    this.useSheet = false;
    this.running = false;
    this.clock = () => performance.now(); // remplaçable pour les tests
  }

  // branchés sur le Listener par app.js
  frame() { if (this.running) this._check(); }
  onset(m, s) { if (this.running) this._onOnset(m, s); }

  load(steps, useSheet) {
    this.steps = steps;
    this.useSheet = useSheet;
    this.roll.handOk = n => this.handOk(n);
    this.restart();
  }

  handOk(n) { return this.hand === 'both' || n.hand === this.hand; }
  required(i = this.idx) { return (this.steps[i]?.notes || []).filter(n => this.handOk(n)); }
  needed(req) {
    if (this.tolerance === 'strict' || req.length === 1) return req.length;
    return Math.max(1, Math.round(req.length * 0.6));
  }

  setHand(h) {
    this.hand = h;
    if (this.steps.length && !this.finished) this._enter(this._firstPlayable(this.idx), true);
  }
  setTolerance(t) { this.tolerance = t; }

  restart() {
    this.idx = 0;
    this.stats = { correct: 0, errors: 0, byMeasure: {}, start: 0, activeMs: 0, lastTick: 0 };
    this.finished = false;
    if (this.useSheet) this.sheet.resetColors();
    this._enter(this._firstPlayable(0), true);
  }

  begin() {
    this.running = true;
    this.stats.start = this.stats.start || this.clock();
    this.stats.lastTick = this.clock();
  }
  pause() { this._accumulate(); this.running = false; }

  _accumulate() {
    const now = this.clock();
    if (this.running && this.stats.lastTick) {
      // on ne compte pas les pauses de plus de 20 s
      this.stats.activeMs += Math.min(20000, now - this.stats.lastTick);
    }
    this.stats.lastTick = now;
  }

  _firstPlayable(i) {
    while (i < this.steps.length && this.required(i).length === 0) i++;
    return i;
  }

  _enter(i, jump = false) {
    const prev = this.steps[this.idx];
    this.idx = Math.min(i, this.steps.length);
    this.sat = new Set();
    this.stepStart = this.clock();
    const step = this.steps[this.idx];
    if (!step) { this._finish(); return; }
    // Creux de référence de chaque note attendue (voir listener.isStruck).
    const prevMidis = new Set(!jump && prev ? prev.notes.map(n => n.midi) : []);
    this.valley = {};
    this.settle = {};
    this.repeated = {};
    const explains = [0, 12, 19, 24, 28];
    const now = this.clock();
    for (const n of step.notes) {
      // « expliquée » : même note, ou harmonique d'une note de l'étape précédente
      // (ex. Mi2 joué juste avant fait sonner Mi3) → seuil de remontée plus bas.
      const rep = [...prevMidis].some(r => explains.includes(n.midi - r));
      this.repeated[n.midi] = rep;
      // On repart du niveau actuel, après un court délai : la frappe qui vient de valider
      // l'étape précédente (et son bruit de marteau) ne doit pas valider celle-ci aussi.
      this.settle[n.midi] = now + SETTLE_MS;
      this.valley[n.midi] = this.listener.raw[n.midi];
    }
    this.prevMidis = prevMidis;
    // notes encore tenues d'après la partition (ex. ronde à la main gauche) : pas des erreurs
    this.held = new Set(prev ? prev.notes.map(n => n.midi) : []);
    for (let j = this.idx - 1; j >= 0 && step.t - this.steps[j].t < 8; j--) {
      for (const n of this.steps[j].notes) if (this.steps[j].t + n.dur > step.t - 0.05) this.held.add(n.midi);
    }
    if (this.useSheet) this.sheet.goTo(step.cursorIndex);
    this._render();
  }

  _render() {
    const step = this.steps[this.idx];
    const req = this.required();
    this.keyboard.setExpected(req.map(n => ({ ...n, sat: this.sat.has(n.midi) })));
    this.roll.setPosition(this.idx, this.sat);
    const total = this.steps.length ? this.steps[this.steps.length - 1].measure + 1 : 0;
    this.onProgress && this.onProgress(step ? step.measure + 1 : total, total);
  }

  _check() {
    this._accumulate();
    if (this.finished) return;
    const req = this.required();
    let changed = false;
    for (const n of req) {
      if (this.sat.has(n.midi)) continue;
      // le creux suit la décroissance naturelle de la note
      const m = n.midi, v = this.listener.raw[m];
      if (this.clock() < this.settle[m]) { this.valley[m] = v; continue; }
      if (v < this.valley[m]) this.valley[m] = v;
      if (this.listener.isStruck(m, this.valley[m], this.repeated[m] ? REP_RISE_DB : undefined)) {
        this.sat.add(n.midi);
        this.keyboard.flash(n.midi, 'ok');
        changed = true;
      }
    }
    if (changed) this._afterSat();
  }

  _afterSat() {
    const req = this.required();
    if (this.sat.size >= this.needed(req)) {
      this.stats.correct += req.length;
      if (this.useSheet) this.sheet.markCurrentDone(note => this.hand === 'both' || this._noteHand(note) === this.hand);
      this._enter(this._firstPlayable(this.idx + 1));
    } else {
      this._render();
    }
  }

  _noteHand(osmdNote) {
    const midi = osmdNote.halfTone + 12;
    return this.steps[this.idx].notes.find(n => n.midi === midi)?.hand;
  }

  _onOnset(m, salience) {
    const step = this.steps[this.idx];
    if (!step || this.finished) return;
    const all = step.notes.map(n => n.midi);
    if (all.includes(m)) return;                       // géré par _check
    const [lo, hi] = this.keyboard.range || [21, 108];
    if (m < lo || m > hi) return;                      // hors de l'étendue du morceau : bruit
    const next = this.steps[this.idx + 1];
    if (next && next.notes.some(n => n.midi === m)) {
      // Jouée en avance : pas une faute. En mode tolérant, si c'est la note suivante
      // (le micro a sans doute raté la note en cours), on rattrape au lieu de bloquer.
      const nreq = this.required(this.idx + 1);
      if (this.tolerance === 'tolerant' && nreq.some(n => n.midi === m) && this.needed(nreq) === 1) {
        this.skipped = (this.skipped || 0) + 1;
        this._enter(this.idx + 1);
        this.sat.add(m);
        this.keyboard.flash(m, 'ok');
        this._afterSat();
      }
      return;
    }
    // harmonique ou résonance d'une note attendue / précédente → pas une erreur
    const refs = [...all, ...this.held];
    if (refs.some(r => HARMONIC.includes(m - r) || m === r)) return;
    if (salience < this.listener.threshold + 3) return;
    if (this.clock() - this.stepStart < 120) return;
    this._error(m);
  }

  _error(m) {
    this.stats.errors++;
    const meas = this.steps[this.idx].measure + 1;
    this.stats.byMeasure[meas] = (this.stats.byMeasure[meas] || 0) + 1;
    this.keyboard.flash(m, 'bad');
    if (this.useSheet) this.sheet.flashCursor('bad');
  }

  // Appui sur le clavier de l'écran (mode sans micro)
  press(m) {
    if (this.finished) return;
    if (!this.running) this.begin();
    const req = this.required();
    if (req.some(n => n.midi === m)) {
      if (this.sat.has(m)) return;
      this.sat.add(m);
      this.keyboard.flash(m, 'ok');
      // au toucher, on exige toutes les notes (on peut toucher plusieurs touches)
      if (this.sat.size >= req.length || this.tolerance === 'tolerant') this._afterSat();
      else this._render();
    } else {
      this._error(m);
    }
  }

  // Mode Lecture : aller à une étape sans compter de statistiques
  jumpTo(i) {
    if (i >= this.steps.length) {
      this.idx = this.steps.length;
      this.keyboard.setExpected([]);
      this.roll.setPosition(this.idx, new Set());
      return;
    }
    this._enter(i, true);
  }

  next() { this._enter(this._firstPlayable(this.idx + 1), true); }
  prev() {
    let i = this.idx - 1;
    while (i > 0 && this.required(i).length === 0) i--;
    this._enter(Math.max(0, i), true);
  }

  _finish() {
    if (this.finished || !this.steps.length) return;
    this._accumulate();
    this.finished = true;
    this.keyboard.setExpected([]);
    this.roll.setPosition(this.steps.length, new Set());
    const { correct, errors, byMeasure, activeMs } = this.stats;
    const accuracy = correct + errors ? correct / (correct + errors) : 1;
    const hard = Object.entries(byMeasure).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => +m);
    this.onDone && this.onDone({ correct, errors, accuracy, activeMs, hard });
  }
}

export { noteName };
