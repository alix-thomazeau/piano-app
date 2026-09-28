// Analyse d'un vrai enregistrement (échantillon du piano) avec le Listener de l'app.
// Usage : real.html?file=<nom du fichier dans test/>
import { Listener, noteName } from '../js/listener.js';
import { fftMagDb } from './fft.js';
import { Practice } from '../js/practice.js';

const SR = 48000, N = 16384, HOP = 1 / 60;
const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };
const params = new URLSearchParams(location.search);

export async function loadAudio(file) {
  const buf = await (await fetch(file)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, SR, SR);
  const decoded = await ctx.decodeAudioData(buf);
  // mixage mono + rééchantillonnage à 48 kHz
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Parcourt l'audio image par image ; cb(L, t) après chaque analyse
export function scan(audio, cb, { from = 0, to = Infinity, sens = 5 } = {}) {
  const L = new Listener();
  L.setupOffline(SR, N);
  L.threshold = 21 - sens * 1.5;
  const t0 = Math.max(N / SR, from), t1 = Math.min(audio.length / SR, to);
  for (let te = t0; te < t1; te += HOP) {
    const end = Math.floor(te * SR);
    L.spec.set(fftMagDb(audio.subarray(end - N, end), N));
    L.spec2.set(fftMagDb(audio.subarray(end - 4096, end), 4096));
    L.time.set(audio.subarray(end - 2048, end));
    L.analyze(te * 1000);
    cb(L, te);
  }
  return L;
}

// Attaques « vérité terrain » : sauts d'énergie large bande (indépendants de la hauteur)
export function energyOnsets(audio) {
  const hop = Math.round(SR * 0.01), win = Math.round(SR * 0.03);
  const env = [];
  for (let i = win; i < audio.length; i += hop) {
    let e = 0;
    for (let j = i - win; j < i; j++) e += audio[j] * audio[j];
    env.push(10 * Math.log10(e / win + 1e-12));
  }
  const on = [];
  for (let k = 5; k < env.length; k++) {
    const rise = env[k] - Math.min(...env.slice(k - 5, k));
    if (rise > 9 && env[k] > -60 && (!on.length || k * 0.01 - on[on.length - 1].t > 0.15)) on.push({ t: k * 0.01 + 0.03, db: env[k] });
  }
  return { on, env };
}

async function main() {
  const file = params.get('file');
  log('Fichier : ' + file);
  const audio = await loadAudio(file);
  log(`Durée : ${(audio.length / SR).toFixed(1)} s`);
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  log(`Crête : ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);

  const { on } = energyOnsets(audio);
  log(`\nAttaques (énergie) : ${on.length}`);

  // détection aveugle de l'app + note la plus forte 120 ms après chaque attaque
  const blind = [];
  const at = new Map(on.map(o => [Math.round((o.t + 0.15) * 60), o]));
  const floors = [];
  scan(audio, (L, t) => {
    if (!L.onOnset) L.onOnset = (m, s) => blind.push({ t: L._t, m, s });
    L._t = t;
    const f = Math.round(t * 60);
    if (at.has(f)) at.get(f).best = { m: L.loudest(), present: L.present(), max: L.frameMax };
    if (f % 30 === 0) floors.push(L.floorDb);
  }, { sens: +(params.get('sens') || 5) });
  floors.sort((a, b) => a - b);
  log(`Bruit de fond moyen (médiane) : ${floors[floors.length >> 1].toFixed(1)} dB`);

  log('\n t(s)   énergie  | la plus forte | présentes');
  for (const o of on) {
    const b = o.best || {};
    log(`${o.t.toFixed(2).padStart(6)}  ${o.db.toFixed(0).padStart(5)} dB | ${(b.m > 0 ? noteName(b.m) : '–').padEnd(6)} (${(b.max || 0).toFixed(0)}) | ${(b.present || []).map(m => noteName(m)).join(' ')}`);
  }
  log(`\nAttaques détectées « à l'aveugle » par l'app : ${blind.length}`);
  log(blind.map(b => `${b.t.toFixed(2)}:${noteName(b.m)}`).join('  '));
  log('\nFIN');
  window.__done = true;
}

// Mode attente simulé : on attend une suite de notes et on regarde quand l'app avance.
// seq = liste de midi ; retourne les instants de validation.
export function waitSim(audio, seq, { from = 0, to = Infinity, sens = 5, tolerance = 'strict' } = {}) {
  const steps = seq.map((m, i) => ({ t: i, measure: i, notes: (Array.isArray(m) ? m : [m]).map(x => ({ midi: x, hand: 'R', dur: 1 })) }));
  const stub = { setExpected() {}, flash() {}, setPosition() {}, handOk: null, range: [21, 108] };
  let now = 0, P = null;
  const passed = [], errors = [];
  scan(audio, (L, t) => {
    now = t * 1000;
    if (!P) {
      P = new Practice({ keyboard: stub, sheet: stub, roll: stub, listener: L });
      P.clock = () => now;
      P._error = m => errors.push({ t, m });
      L.onOnset = (m, s) => P.onset(m, s);
      P.load(steps, false);
      P.setTolerance(tolerance);
      P.running = true;
    }
    const before = P.idx;
    P.frame();
    if (P.idx !== before) passed.push({ t, step: before, m: seq[before] });
  }, { from, to, sens });
  return { passed, errors, idx: P.idx };
}

async function mainWait() {
  const file = params.get('file');
  const audio = await loadAudio(file);
  const { on } = energyOnsets(audio);
  // 1) gamme Do3 → Do6 (touches blanches) à partir de 6 s
  const whites = [];
  for (let m = 48; m <= 84; m++) if ([0, 2, 4, 5, 7, 9, 11].includes(m % 12)) whites.push(m);
  const r = waitSim(audio, whites, { from: 6, to: 46 });
  log('▶ Gamme Do3→Do6 en mode attente');
  log(r.passed.map(p => {
    const real = on.find(o => o.t > p.t - 1.2 && o.t <= p.t + 0.05);
    return `${noteName(p.m)} @${p.t.toFixed(2)}s ${real ? `(frappe ${real.t.toFixed(2)}s, +${Math.round((p.t - real.t) * 1000)} ms)` : '(AUCUNE FRAPPE → faux positif)'}`;
  }).join(String.fromCharCode(10)));
  log(`validées : ${r.passed.length}/${whites.length}, fausses notes : ${r.errors.length}`);
  // 1b) graves Do2 → Si2 (joués avant 6,6 s)
  const bass = [36, 38, 40, 41, 43, 45, 47];
  const rb = waitSim(audio, bass, { from: 0, to: 6.6 });
  log(`▶ Graves Do2→Si2 : ${rb.passed.length}/7 validées ${rb.passed.map(p => noteName(p.m) + '@' + p.t.toFixed(2)).join(' ')}`);
  // 1c) accords (mode tolérant), voicings supposés
  const chords = [[60, 64, 67], [57, 60, 64], [55, 59, 62]];
  const rc = waitSim(audio, chords, { from: 70, to: 95, tolerance: 'tolerant' });
  log(`▶ Accords Do/Lam/Sol (tolérant) : ${rc.passed.length}/3 ${rc.passed.map(p => p.t.toFixed(2) + 's').join(' ')}`);
  // 2) silences : on attend la main gauche de l'Ode, on ne joue rien
  const lh = [48, 47, 45, 43, 48, 47, 45, 43, 60, 64, 65, 67];
  for (const [a, b] of [[46, 52.5], [63, 71], [91, 104]]) {
    const w = waitSim(audio, lh, { from: a, to: b });
    log(`▶ Silence ${a}–${b} s (attend ${lh.map(m => noteName(m)).join(' ')}) : ${w.passed.length} fausse(s) validation(s) ${w.passed.map(p => noteName(p.m) + '@' + p.t.toFixed(1)).join(' ')}`);
  }
  log('FIN');
  window.__done = true;
}

if (params.get('mode') === 'wait') mainWait().catch(e => { log('ERREUR ' + e.stack); window.__done = true; });
else if (params.get('file')) main().catch(e => { log('ERREUR ' + e.stack); window.__done = true; });
