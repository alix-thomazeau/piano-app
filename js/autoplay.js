// Mode Lecture : la partition avance toute seule au tempo choisi (sans micro).
// Métronome et son des notes optionnels, décompte d'une mesure avant de démarrer.

export class AutoPlayer {
  constructor({ practice, roll, onEnd, onState }) {
    Object.assign(this, { practice, roll, onEnd, onState });
    this.bpm = 60;
    this.metronome = true;
    this.sound = false;
    this.playing = false;
    this.pos = 0;           // position en noires
    this._tick = this._tick.bind(this);
  }

  get ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  }

  setSong(steps, beatsPerMeasure) {
    this.steps = steps;
    this.bpMeasure = beatsPerMeasure || 4;
    this.end = steps.length ? Math.max(...steps.map(s => s.t + Math.max(...s.notes.map(n => n.dur)))) : 0;
    this.pause();
    this.pos = steps[0]?.t || 0;
  }

  // positionne la lecture sur l'étape en cours de la pratique
  syncFromPractice() {
    const s = this.steps[this.practice.idx];
    this.pos = s ? s.t : 0;
  }

  async play() {
    if (this.playing || !this.steps?.length) return;
    await this.ctx.resume();
    if (this.practice.finished || this.pos >= this.end) { this.practice.restart(); this.pos = this.steps[0].t; }
    else this.syncFromPractice();
    this.playing = true;
    const spb = 60 / this.bpm;
    // décompte : une mesure de clics avant de démarrer
    const countIn = this.bpMeasure;
    this.t0 = this.ctx.currentTime + 0.1 + countIn * spb;
    this.pos0 = this.pos;
    this.nextClick = Math.ceil(this.pos - countIn - 1e-6);
    this.nextNoteStep = this.practice.idx;
    this._scheduler = setInterval(() => this._schedule(), 25);
    this._schedule();
    this.onState && this.onState(true);
    requestAnimationFrame(this._tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._scheduler);
    this.roll.autoT = null;
    this.onState && this.onState(false);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  setBpm(bpm) {
    const was = this.playing;
    if (was) { this.pos = this._posAt(this.ctx.currentTime); this.pause(); }
    this.bpm = bpm;
    if (was) this.play();
  }

  _posAt(time) { return this.pos0 + (time - this.t0) * this.bpm / 60; }
  _timeAt(pos) { return this.t0 + (pos - this.pos0) * 60 / this.bpm; }

  // Planification audio (clics + notes) ~150 ms à l'avance
  _schedule() {
    const horizon = this.ctx.currentTime + 0.15;
    while (this._timeAt(this.nextClick) < horizon) {
      if (this.nextClick <= this.end) {
        const t = this._timeAt(this.nextClick);
        const beatInBar = ((Math.round(this.nextClick) % this.bpMeasure) + this.bpMeasure) % this.bpMeasure;
        const countIn = this.nextClick < this.pos0;
        if (this.metronome || countIn) this._click(t, beatInBar === 0);
      }
      this.nextClick++;
    }
    if (this.sound) {
      while (this.nextNoteStep < this.steps.length && this._timeAt(this.steps[this.nextNoteStep].t) < horizon) {
        const s = this.steps[this.nextNoteStep];
        const t = Math.max(this.ctx.currentTime, this._timeAt(s.t));
        for (const n of s.notes) this._note(n.midi, t, n.dur * 60 / this.bpm, this.practice.handOk(n) ? 0.5 : 0.25);
        this.nextNoteStep++;
      }
    } else {
      while (this.nextNoteStep < this.steps.length && this._timeAt(this.steps[this.nextNoteStep].t) < horizon) this.nextNoteStep++;
    }
  }

  _tick() {
    if (!this.playing) return;
    const pos = this._posAt(this.ctx.currentTime);
    this.pos = Math.max(this.pos0, pos);
    this.roll.autoT = this.pos;
    // étape courante = dernière étape dont le début est passé
    const p = this.practice;
    let i = p.idx;
    while (i + 1 < this.steps.length && this.steps[i + 1].t <= this.pos + 1e-6) i++;
    // on saute les étapes sans note pour la main choisie
    if (i !== p.idx && this.pos >= this.pos0) p.jumpTo(i);
    if (this.pos >= this.end) {
      this.pause();
      p.jumpTo(this.steps.length);
      this.onEnd && this.onEnd();
      return;
    }
    requestAnimationFrame(this._tick);
  }

  _click(t, accent) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + 0.06);
  }

  // son de piano très simple (quelques harmoniques qui s'éteignent)
  _note(midi, t, dur, vel) {
    const c = this.ctx, f = 440 * 2 ** ((midi - 69) / 12);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.005);
    g.gain.setTargetAtTime(0.0001, t + 0.005, 0.6);
    g.gain.setTargetAtTime(0.0001, t + Math.max(0.1, dur * 0.95), 0.05);
    g.connect(c.destination);
    [1, 2, 3, 4].forEach((h, i) => {
      const o = c.createOscillator(), og = c.createGain();
      o.frequency.value = f * h;
      og.gain.value = [1, 0.4, 0.2, 0.1][i];
      o.connect(og).connect(g);
      o.start(t); o.stop(t + dur + 0.4);
    });
  }
}
