import { noteName } from './listener.js';

const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);

// Géométrie partagée par le clavier et la vue « notes qui tombent »
export function keyLayout(lo, hi, width) {
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = width / whites.length;
  const map = {};
  whites.forEach((m, i) => { map[m] = { x: i * ww, w: ww, black: false }; });
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    const left = map[m - 1];
    if (!left) continue;
    const bw = ww * 0.6;
    map[m] = { x: left.x + ww - bw / 2, w: bw, black: true };
  }
  return map;
}

export class Keyboard {
  constructor(el, { onPress } = {}) {
    this.el = el;
    this.onPress = onPress;
    this.keys = {};
    this.range = [48, 83];
    new ResizeObserver(() => this.layout()).observe(el);
    el.addEventListener('pointerdown', e => {
      const k = e.target.closest('.key');
      if (!k) return;
      e.preventDefault();
      this.onPress && this.onPress(+k.dataset.m);
    });
  }

  setRange(lo, hi) {
    this.range = [lo, hi];
    this.el.innerHTML = '';
    this.keys = {};
    for (let m = lo; m <= hi; m++) {
      const d = document.createElement('div');
      d.className = 'key ' + (isBlack(m) ? 'black' : 'white');
      d.dataset.m = m;
      d.innerHTML = `<span class="fg"></span>${m % 12 === 0 ? `<span class="lbl">${noteName(m)}</span>` : ''}`;
      this.el.appendChild(d);
      this.keys[m] = d;
    }
    this.layout();
  }

  layout() {
    const [lo, hi] = this.range;
    const width = this.el.clientWidth;
    if (!width) return;
    const L = keyLayout(lo, hi, width);
    for (const m in this.keys) {
      const g = L[m], d = this.keys[m];
      if (!g) { d.style.display = 'none'; continue; }
      d.style.left = g.x + 'px';
      d.style.width = g.w + 'px';
    }
    this.layoutCb && this.layoutCb();
  }

  // expected : [{midi, hand, finger, sat}]
  setExpected(list) {
    for (const m in this.keys) {
      const d = this.keys[m];
      d.classList.remove('exp-R', 'exp-L', 'exp-sat');
      d.firstChild.textContent = '';
    }
    for (const n of list) {
      const d = this.keys[n.midi];
      if (!d) continue;
      d.classList.add(n.sat ? 'exp-sat' : 'exp-' + n.hand);
      if (n.finger) d.firstChild.textContent = n.finger;
    }
  }

  flash(m, kind) {
    const d = this.keys[m];
    if (!d) return;
    const c = kind === 'ok' ? 'flash-ok' : 'flash-bad';
    d.classList.remove(c);
    void d.offsetWidth;
    d.classList.add(c);
    clearTimeout(d._t);
    d._t = setTimeout(() => d.classList.remove(c), 350);
  }

  setSounding(set) {
    for (const m in this.keys) this.keys[m].classList.toggle('sounding', set.has(+m));
  }
}
