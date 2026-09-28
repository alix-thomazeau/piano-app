import { listSongs, getSong, putSong, deleteSong, getPref, setPref } from './db.js';
import { createListener, noteName, sensToThreshold } from './listener.js';
import { detectFormat, cleanTitle, parseMidi, keyRange } from './score.js';
import { Keyboard } from './keyboard.js';
import { Sheet } from './sheet.js';
import { Roll } from './roll.js';
import { Practice } from './practice.js';

const $ = s => document.querySelector(s);
const listener = createListener();
window.__pc = { listener }; // aide au débogage

// ---------- utilitaires ----------
function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + screen));
}
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}
const fmtDur = ms => {
  const m = Math.round(ms / 60000);
  return m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : 'jamais';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let sensitivity = getPref('sens', 5);
listener.threshold = sensToThreshold(sensitivity);

// ---------- bibliothèque ----------
async function seedDemo() {
  if (getPref('seeded', false)) return;
  try {
    const res = await fetch('demo/ode-a-la-joie.musicxml');
    const data = await res.arrayBuffer();
    await putSong({ id: 'demo-ode', title: 'Ode à la joie (démo)', format: 'musicxml', data, addedAt: Date.now(), stats: {} });
    setPref('seeded', true);
  } catch (e) { console.warn('démo non chargée', e); }
}

async function renderLibrary() {
  const songs = (await listSongs()).sort((a, b) => (b.stats?.lastPlayed || b.addedAt) - (a.stats?.lastPlayed || a.addedAt));
  const ul = $('#song-list');
  ul.innerHTML = '';
  $('#lib-hint').textContent = songs.length
    ? 'Choisis un morceau pour t\'entraîner.'
    : 'Importe un fichier MIDI ou MusicXML (MuseScore → Download → MusicXML).';
  for (const s of songs) {
    const st = s.stats || {};
    const li = document.createElement('li');
    li.className = 'song';
    li.innerHTML = `
      <div class="t"></div>
      <div class="meta">Dernière séance : ${fmtDate(st.lastPlayed)} · ${fmtDur(st.totalMs || 0)} au total</div>
      <div class="meta">${st.sessions ? `${st.sessions} séance${st.sessions > 1 ? 's' : ''}${st.bestAccuracy != null ? ` · meilleure précision ${Math.round(st.bestAccuracy * 100)} %` : ''}` : 'Pas encore joué'}</div>
      <div class="row"><span class="tag">${s.format === 'midi' ? 'MIDI' : 'PARTITION'}</span><div class="spacer"></div>
        <button class="btn ghost danger" data-del>Supprimer</button></div>`;
    li.querySelector('.t').textContent = s.title;
    li.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return;
      openSong(s.id);
    });
    li.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${s.title} » ?`)) return;
      await deleteSong(s.id);
      renderLibrary();
    });
    ul.appendChild(li);
  }
}

$('#file-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      const data = await f.arrayBuffer();
      const format = detectFormat(f.name, data);
      let title = cleanTitle(f.name);
      if (format === 'midi') {
        const p = parseMidi(data);
        if (!p.steps.length) throw new Error('aucune note');
        if (p.title && p.title.length > 2) title = p.title;
      } else if (format === 'musicxml') {
        const txt = new TextDecoder().decode(data);
        if (!/<score-(partwise|timewise)/.test(txt)) throw new Error('pas un fichier MusicXML');
        const m = txt.match(/<work-title>([^<]+)<\/work-title>/) || txt.match(/<movement-title>([^<]+)<\/movement-title>/);
        if (m) title = m[1].trim();
      }
      await putSong({ id: uid(), title, format, data, addedAt: Date.now(), stats: {} });
      toast(`« ${title} » importé`);
    } catch (err) {
      console.error(err);
      toast(`Impossible de lire ${f.name} (${err.message})`, 4000);
    }
  }
  renderLibrary();
});

$('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

// ---------- pratique ----------
const keyboard = new Keyboard($('#keyboard'), { onPress: m => practice.press(m) });
const sheet = new Sheet($('#sheet'), $('#sheet-wrap'));
const roll = new Roll($('#roll'));
let current = null; // morceau en cours
let view = getPref('view', 'sheet');

const practice = new Practice({
  keyboard, sheet, roll, listener,
  onProgress: (m, total) => { $('#progress-txt').textContent = total ? `Mesure ${m} / ${total}` : ''; },
  onDone: async res => {
    $('#done-stats').innerHTML = `
      <div><b>${Math.round(res.accuracy * 100)} %</b><span>précision</span></div>
      <div><b>${fmtDur(res.activeMs)}</b><span>de pratique</span></div>
      <div><b>${res.correct}</b><span>notes justes</span></div>
      <div><b>${res.errors}</b><span>fausses notes</span></div>
      <div class="full"><span>À retravailler</span><b style="font-size:17px">${res.hard.length ? 'mesures ' + res.hard.join(', ') : 'rien, bravo !'}</b></div>`;
    $('#done-overlay').classList.remove('hidden');
    await saveSession(res.accuracy, true);
  },
});

listener.onFrame = info => {
  const pct = Math.min(100, info.level * 500);
  if (mode === 'practice') {
    $('#mic-meter').style.width = pct + '%';
    practice.frame();
  } else if (mode === 'mictest') {
    mictestFrame(pct);
  }
};
listener.onOnset = (m, s) => { if (mode === 'practice') practice.onset(m, s); };
let mode = 'library';

async function saveSession(accuracy, finished) {
  if (!current) return;
  const ms = practice.stats.activeMs;
  if (ms < 5000 && !finished) return;
  const song = await getSong(current.id);
  if (!song) return;
  const st = song.stats || {};
  st.totalMs = (st.totalMs || 0) + ms;
  st.lastPlayed = Date.now();
  st.sessions = (st.sessions || 0) + 1;
  if (finished) st.bestAccuracy = Math.max(st.bestAccuracy || 0, accuracy);
  st.history = [...(st.history || []), { date: Date.now(), ms, accuracy: finished ? accuracy : null }].slice(-200);
  song.stats = st;
  await putSong(song);
  practice.stats.activeMs = 0; // évite de compter deux fois
}

async function openSong(id) {
  const song = await getSong(id);
  if (!song) return;
  current = song;
  mode = 'practice';
  show('practice');
  $('#practice-title').textContent = song.title;
  $('#practice-overlay').classList.remove('hidden');
  $('#done-overlay').classList.add('hidden');
  $('#mic-error').textContent = '';

  let steps, beatsPerMeasure;
  const isSheet = song.format !== 'midi';
  try {
    if (isSheet) {
      setView('sheet'); // la partition doit être visible pour être mise en page
      ({ steps, beatsPerMeasure } = await sheet.load(song.data, song.format));
    } else {
      $('#sheet').innerHTML = '';
      ({ steps, beatsPerMeasure } = parseMidi(song.data));
    }
  } catch (err) {
    console.error(err);
    toast('Erreur de lecture du fichier : ' + err.message, 5000);
    goLibrary();
    return;
  }
  const range = keyRange(steps);
  keyboard.setRange(range[0], range[1]);
  roll.setSong(steps, range, beatsPerMeasure);
  $('#seg-view [data-v="sheet"]').disabled = !isSheet;
  setView(isSheet ? view : 'roll');
  practice.load(steps, isSheet);
  window.__pc.practice = practice;
}

function setView(v, remember) {
  if (v === 'sheet' && current?.format === 'midi') v = 'roll';
  document.querySelectorAll('#seg-view button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#sheet-wrap').classList.toggle('hidden', v !== 'sheet');
  $('#roll').classList.toggle('hidden', v !== 'roll');
  if (v === 'roll') roll.start(); else roll.stop();
  if (v === 'sheet' && sheet.osmd) requestAnimationFrame(() => sheet.scrollToCursor());
  if (remember) { view = v; setPref('view', v); }
}

function segment(sel, attr, onChange, initial) {
  const btns = document.querySelectorAll(sel + ' button');
  const set = val => btns.forEach(b => b.classList.toggle('on', b.dataset[attr] === val));
  btns.forEach(b => b.addEventListener('click', () => { set(b.dataset[attr]); onChange(b.dataset[attr]); }));
  set(initial);
  onChange(initial);
}
document.querySelectorAll('#seg-view button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v, true)));
segment('#seg-hand', 'h', h => practice.setHand(h), 'both');
segment('#seg-tol', 't', t => { practice.setTolerance(t); setPref('tol', t); }, getPref('tol', 'tolerant'));

$('#btn-start-mic').addEventListener('click', async () => {
  try {
    await listener.start();
    $('#mic-state').classList.add('on');
    $('#practice-overlay').classList.add('hidden');
    practice.begin();
  } catch (err) {
    console.error(err);
    $('#mic-error').textContent = 'Micro indisponible : ' + (err.name === 'NotAllowedError'
      ? 'autorise le micro dans Réglages › Safari › Micro.' : err.message);
  }
});
$('#btn-start-touch').addEventListener('click', () => {
  $('#practice-overlay').classList.add('hidden');
  practice.begin();
});
$('#btn-restart').addEventListener('click', () => { practice.restart(); practice.begin(); });
$('#btn-next').addEventListener('click', () => practice.next());
$('#btn-prev').addEventListener('click', () => practice.prev());
$('#btn-again').addEventListener('click', () => {
  $('#done-overlay').classList.add('hidden');
  practice.restart();
  practice.begin();
});

async function goLibrary() {
  if (mode === 'practice') {
    practice.pause();
    await saveSession(null, false);
  }
  listener.stop();
  $('#mic-state').classList.remove('on');
  roll.stop();
  mode = 'library';
  current = null;
  show('library');
  renderLibrary();
}
$('#btn-back').addEventListener('click', goLibrary);
$('#btn-done-back').addEventListener('click', goLibrary);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'practice') { practice.pause(); saveSession(null, false); }
  else if (!document.hidden && mode === 'practice' && $('#practice-overlay').classList.contains('hidden')) practice.begin();
});

// ---------- test du micro ----------
const kbTest = new Keyboard($('#keyboard-test'));
$('#btn-mictest').addEventListener('click', () => {
  mode = 'mictest';
  show('mictest');
  kbTest.setRange(36, 95);
});
$('#btn-mictest-start').addEventListener('click', async () => {
  try {
    await listener.start();
    $('#btn-mictest-start').classList.add('hidden');
  } catch (err) {
    toast('Micro indisponible : ' + err.message, 4000);
  }
});
$('#btn-mictest-back').addEventListener('click', () => {
  if (recorder) recorder.stop();
  $('#btn-mictest-start').classList.remove('hidden');
  goLibrary();
});
const sens = $('#sens');
sens.value = sensitivity;
$('#sens-val').textContent = sensitivity;
sens.addEventListener('input', () => {
  sensitivity = +sens.value;
  $('#sens-val').textContent = sensitivity;
  listener.threshold = sensToThreshold(sensitivity);
  setPref('sens', sensitivity);
});
let lastShown = 0;
function mictestFrame(pct) {
  $('#mt-meter').style.width = pct + '%';
  const present = listener.present();
  kbTest.setSounding(new Set(present));
  const now = performance.now();
  const best = listener.loudest();
  if (best > 0) {
    $('#mt-note').textContent = noteName(best);
    lastShown = now;
  } else if (now - lastShown > 1200) {
    $('#mt-note').textContent = '–';
  }
  $('#mt-list').textContent = present.length ? 'Entendu : ' + present.map(m => noteName(m)).join(' · ') : '';
}

// ---------- enregistrement d'un échantillon (pour régler la détection) ----------
let recorder = null, recBlob = null, recTimer = null;
$('#btn-rec').addEventListener('click', async () => {
  if (recorder) { recorder.stop(); return; }
  try {
    if (!listener.stream) {
      await listener.start();
      $('#btn-mictest-start').classList.add('hidden');
    }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(listener.stream, type ? { mimeType: type, audioBitsPerSecond: 256000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      recBlob = new Blob(chunks, { type: recorder.mimeType || type });
      recorder = null;
      clearInterval(recTimer);
      $('#btn-rec').textContent = '⏺ Recommencer';
      $('#rec-state').textContent = `Enregistré (${(recBlob.size / 1e6).toFixed(1)} Mo)`;
      $('#btn-rec-share').classList.remove('hidden');
    };
    recorder.start(1000);
    const t0 = Date.now();
    $('#btn-rec').textContent = '⏹ Arrêter';
    $('#btn-rec-share').classList.add('hidden');
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('#rec-state').textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  } catch (err) {
    toast('Enregistrement impossible : ' + err.message, 4000);
  }
});
$('#btn-rec-share').addEventListener('click', async () => {
  if (!recBlob) return;
  const ext = recBlob.type.includes('mp4') ? 'm4a' : 'webm';
  const d = new Date();
  const name = `piano-echantillon-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  const file = new File([recBlob], name, { type: recBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

// ---------- démarrage ----------
(async () => {
  await seedDemo();
  renderLibrary();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();
