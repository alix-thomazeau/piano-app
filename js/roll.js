// Vue « notes qui tombent » : les notes descendent vers le clavier.
import { keyLayout } from './keyboard.js';

const COLORS = { R: '#5aa9ff', L: '#ffab4c', done: '#2f6b48', dim: '#3a3f55', ok: '#5cc88c' };

export class Roll {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.steps = [];
    this.idx = 0;
    this.viewT = 0;
    this.range = [48, 83];
    this.beatsPerMeasure = 4;
    this.handOk = () => true;
    this.sat = new Set();
    this.active = false;
    this._loop = this._loop.bind(this);
  }

  setSong(steps, range, beatsPerMeasure) {
    this.steps = steps;
    this.range = range;
    this.beatsPerMeasure = beatsPerMeasure || 4;
    this.viewT = steps[0]?.t || 0;
    // notes « à plat » pour le dessin
    this.notes = [];
    steps.forEach((s, i) => s.notes.forEach(n => this.notes.push({ ...n, t: s.t, step: i })));
    this.endT = steps.length ? Math.max(...this.notes.map(n => n.t + n.dur)) : 0;
  }

  setPosition(idx, sat) { this.idx = idx; this.sat = sat || new Set(); }

  start() { if (!this.active) { this.active = true; requestAnimationFrame(this._loop); } }
  stop() { this.active = false; }

  _loop() {
    if (!this.active) return;
    this.draw();
    requestAnimationFrame(this._loop);
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const targetT = this.steps[this.idx]?.t ?? this.endT;
    this.viewT += (targetT - this.viewT) * 0.18;
    const ppb = H / (this.beatsPerMeasure * 2.2);   // ~2 mesures visibles
    const L = keyLayout(this.range[0], this.range[1], W);
    const yOf = t => H - (t - this.viewT) * ppb;

    // lignes des touches noires (repères) et barres de mesure
    g.fillStyle = '#171a25';
    for (const m in L) if (L[m].black) g.fillRect(L[m].x, 0, L[m].w, H);
    g.strokeStyle = '#ffffff1f';
    g.lineWidth = 1;
    const bpm = this.beatsPerMeasure;
    const firstBar = Math.floor(this.viewT / bpm) * bpm;
    for (let t = firstBar; yOf(t) > 0; t += bpm) {
      const y = yOf(t);
      if (y > H) continue;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.fillStyle = '#ffffff55'; g.font = '11px sans-serif';
      g.fillText(String(Math.round(t / bpm) + 1), 4, y - 4);
    }

    // notes
    for (const n of this.notes) {
      const y0 = yOf(n.t), y1 = yOf(n.t + n.dur);
      if (y1 > H || y0 < 0) continue;
      const k = L[n.midi];
      if (!k) continue;
      let col;
      if (n.step < this.idx) col = COLORS.done;
      else if (!this.handOk(n)) col = COLORS.dim;
      else if (n.step === this.idx && this.sat.has(n.midi)) col = COLORS.ok;
      else col = COLORS[n.hand];
      const pad = k.black ? 1 : 2;
      const h = Math.max(6, y0 - y1 - 2);
      g.fillStyle = col;
      roundRect(g, k.x + pad, y0 - h, k.w - pad * 2, h, 5);
      g.fill();
      if (n.step === this.idx && this.handOk(n)) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      }
      if (n.finger && k.w > 12 && h > 14) {
        g.fillStyle = '#0b0c12'; g.font = 'bold 12px sans-serif'; g.textAlign = 'center';
        g.fillText(n.finger, k.x + k.w / 2, y0 - 5);
        g.textAlign = 'left';
      }
    }
    // ligne d'arrivée
    g.fillStyle = '#5cc88c';
    g.fillRect(0, H - 2, W, 2);
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
