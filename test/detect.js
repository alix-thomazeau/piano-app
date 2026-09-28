// Banc de test hors-ligne de la détection : on synthétise (ou on charge) un enregistrement,
// on le découpe en images de 1/60 s comme le ferait l'AnalyserNode, et on fait tourner
// le vrai Listener + la vraie Practice dessus. Aucun micro ni horloge réelle nécessaire.
import { Listener } from '../js/listener.js';
import { Practice } from '../js/practice.js';
import { stepsFromOsmd, keyRange } from '../js/score.js';
import { fftMagDb } from './fft.js';

const SR = 48000, N = 16384, HOP = 1 / 60;
const TRACE = +new URLSearchParams(location.search).get('trace') || 0;
const trace = [];
const TFROM = +new URLSearchParams(location.search).get('tfrom') || 0;
const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };

// ---------- synthèse « piano » ----------
// events: [{ midi, t, dur, vel }]
async function render(events, total, noise = 0.0006) {
  const ctx = new OfflineAudioContext(1, Math.ceil(total * SR), SR);
  const nb = ctx.createBuffer(1, ctx.length, SR);
  const d = nb.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < d.length; i++) { lp = lp * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = (Math.random() * 2 - 1) * noise + lp * noise * 8; }
  const ns = ctx.createBufferSource(); ns.buffer = nb; ns.connect(ctx.destination); ns.start();
  for (const e of events) {
    const f = 440 * 2 ** ((e.midi - 69) / 12);
    const tau = 1.8 * Math.pow(0.5, (e.midi - 48) / 24);   // les aigus s'éteignent plus vite
    const B = 0.0004 * Math.pow(2, (e.midi - 60) / 24);    // inharmonicité
    for (let h = 1; h <= 10; h++) {
      const fh = f * h * Math.sqrt(1 + B * h * h);
      if (fh > SR / 2.2) break;
      const o = ctx.createOscillator(); o.frequency.value = fh;
      const g = ctx.createGain();
      // graves : fondamentale faible (comme un vrai piano)
      const lowCut = e.midi < 48 ? (h === 1 ? 0.25 : 1) : 1;
      const a = e.vel * 0.1 * lowCut / Math.pow(h, 1.1);
      const t0 = e.t, t1 = e.t + e.dur;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(a, t0 + 0.004);
      g.gain.setTargetAtTime(0, t0 + 0.004, tau / h ** 0.5);
      g.gain.setTargetAtTime(0, t1, 0.05);          // étouffoir au relâchement
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t1 + 0.5);
    }
  }
  return (await ctx.startRendering()).getChannelData(0);
}

// ---------- exécution d'un scénario ----------
function run(steps, audio, { hand = 'both', tolerance = 'strict', onsets }) {
  const L = new Listener();
  L.setupOffline(SR, N);
  const stub = { setExpected() {}, flash() {}, setPosition() {}, handOk: null, range: keyRange(steps) };
  const P = new Practice({ keyboard: stub, sheet: stub, roll: stub, listener: L });
  let now = 0;
  P.clock = () => now;
  const errors = [];
  L.onOnset = (m, s) => P.onset(m, s);
  P._error = function (m) { errors.push({ m, t: now / 1000, step: this.idx, sal: L.sal[m].toFixed(0), max: L.frameMax.toFixed(0) }); };
  P.load(steps, false);
  P.setHand(hand);
  P.setTolerance(tolerance);
  P.running = true;
  const passedAt = [];   // instant où l'étape i a été validée
  let lastIdx = P.idx;
  for (let te = N / SR; te < audio.length / SR; te += HOP) {
    const end = Math.floor(te * SR);
    L.spec.set(fftMagDb(audio.subarray(end - N, end), N));
    L.spec2.set(fftMagDb(audio.subarray(end - 4096, end), 4096));
    L.time.set(audio.subarray(end - 2048, end));
    now = te * 1000;
    L.analyze(now);
    P.frame();
    if (TRACE && now > TFROM * 1000 && now < TFROM * 1000 + 3000) {
      const m = TRACE;
      trace.push(`${te.toFixed(2)} idx=${P.idx} raw=${L.raw[m].toFixed(0)} sal=${L.sal[m].toFixed(0)} h1=${L.h1[m].toFixed(0)} dyn=${L.dynThreshold(4).toFixed(0)} val=${P.valley?.[m]?.toFixed(0)} broad=${L.broadRise.toFixed(1)} rep=${P.repeated?.[m]} nb=${[-2,-1,1,2].map(d => L.sal[m + d].toFixed(0))}`);
    }
    if (P.idx !== lastIdx) { for (let i = lastIdx; i < P.idx; i++) passedAt[i] = te; lastIdx = P.idx; }
    if (P.finished) break;
  }
  // bilan
  const played = steps.map((s, i) => i).filter(i => P.required(i).length);
  let early = 0, late = [], missed = 0; const earlyList = [];
  for (const i of played) {
    if (passedAt[i] == null) { missed++; continue; }
    const lat = passedAt[i] - onsets[i];
    if (lat < 0) { early++; earlyList.push(`#${i}(${steps[i].notes.map(n => n.midi)}) ${Math.round(lat * 1000)}ms`); } else late.push(lat);
  }
  late.sort((a, b) => a - b);
  return {
    validées: played.length - missed + '/' + played.length,
    'avance trop tôt': early + (early ? ' → ' + earlyList.slice(0, 5).join(', ') : ''),
    'latence médiane (ms)': Math.round((late[late.length >> 1] || 0) * 1000),
    'latence max (ms)': Math.round((late[late.length - 1] || 0) * 1000),
    'fausses notes signalées': errors.length + (errors.length ? ' → ' + errors.slice(0, 8).map(e => `${e.m}@${e.t.toFixed(2)}s[${e.sal}/${e.max}]`).join(', ') : ''),
    fini: P.finished ? 'oui' : `non, bloqué à l'étape ${P.idx} (${P.required().map(n => n.midi)}) sat=${[...P.sat]}`,
    manquées: played.filter(i => passedAt[i] == null).join(',') + ' | tardives: ' + played.filter(i => passedAt[i] - onsets[i] > 0.4).map(i => `#${i}(${steps[i].notes.map(n => n.midi)})`).join(' '),
  };
}

function perform(steps, { bpm = 80, vel = 1, only = null, wrong = [] } = {}) {
  const spb = 60 / bpm, lead = 0.6;
  const events = [], onsets = [];
  steps.forEach((s, i) => {
    const t = lead + s.t * spb + (Math.random() - 0.5) * 0.02;
    onsets[i] = t;
    s.notes.forEach(n => {
      if (only && n.hand !== only) return;
      events.push({ midi: n.midi, t: t + Math.random() * 0.015, dur: Math.max(0.15, n.dur * spb * 0.92), vel: vel * (0.7 + Math.random() * 0.3) });
    });
  });
  for (const w of wrong) events.push({ midi: w.midi, t: lead + w.t * spb, dur: 0.3, vel });
  const total = lead + Math.max(...steps.map(s => s.t + Math.max(...s.notes.map(n => n.dur)))) * spb + 1;
  return { events, onsets, total };
}

async function main() {
  const osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('sheet'), { backend: 'svg' });
  await osmd.load(await (await fetch('../demo/ode-a-la-joie.musicxml')).text());
  osmd.render();
  const { steps } = stepsFromOsmd(osmd);
  log(`Ode à la joie : ${steps.length} étapes\n`);

  const scenarios = [
    ['Deux mains, 80 bpm, strict', { bpm: 80 }, { tolerance: 'strict' }],
    ['Deux mains, 110 bpm, tolérant', { bpm: 110 }, { tolerance: 'tolerant' }],
    ['Joué doucement (vel 0.3), 80 bpm', { bpm: 80, vel: 0.3 }, { tolerance: 'strict' }],
    ['MD seule demandée, 2 mains jouées', { bpm: 80 }, { hand: 'R', tolerance: 'strict' }],
    ['3 fausses notes (Fa#4, Si♭4, Do#3)', { bpm: 70, wrong: [{ midi: 66, t: 2.5 }, { midi: 70, t: 9.5 }, { midi: 49, t: 17.5 }] }, { tolerance: 'strict' }],
  ];
  const only = new URLSearchParams(location.search).get('n');
  for (const [name, perf, opts] of only ? scenarios.slice(0, +only) : scenarios) {
    const p = perform(steps, perf);
    const audio = await render(p.events, p.total);
    const r = run(steps, audio, { ...opts, onsets: p.onsets });
    if (TRACE) log('onsets: ' + p.onsets.slice(13, 19).map(x => x.toFixed(2)).join(' '));
    log('▶ ' + name);
    for (const [k, v] of Object.entries(r)) log(`   ${k} : ${v}`);
    if (TRACE) { log(trace.filter((_, i) => i % 2 === 0).join(String.fromCharCode(10))); trace.length = 0; }
    log('');
  }
  // Rien joué : ne doit jamais avancer
  const silence = await render([], 4);
  const r = run(steps, silence, { onsets: steps.map(() => 0) });
  log('▶ Silence 4 s');
  log(`   validées : ${r['validées']} (attendu 0/…), fausses notes : ${r['fausses notes signalées']}`);
  log('\nFIN');
  window.__done = true;
}
main().catch(e => { log('ERREUR ' + e.stack); window.__done = true; });
