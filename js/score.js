// Conversion des fichiers en une liste d'« étapes » : chaque étape = les notes à attaquer ensemble.
// Step = { t (temps en noires), measure (index 0..), notes: [{ midi, hand:'R'|'L', dur (noires), finger }],
//          cursorIndex (MusicXML seulement) }

export function detectFormat(name, bytes) {
  const n = name.toLowerCase();
  const head = new Uint8Array(bytes.slice(0, 4));
  if (head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64) return 'midi'; // "MThd"
  if (head[0] === 0x50 && head[1] === 0x4b) return 'mxl';                                       // zip
  if (n.endsWith('.mid') || n.endsWith('.midi')) return 'midi';
  if (n.endsWith('.mxl')) return 'mxl';
  return 'musicxml';
}

export function cleanTitle(filename) {
  return filename.replace(/\.(musicxml|xml|mxl|midi?)$/i, '').replace(/[_-]+/g, ' ').trim();
}

// ---------- MIDI ----------
export function parseMidi(buffer) {
  const midi = new window.Midi(buffer);
  const ppq = midi.header.ppq || 480;
  const ts = midi.header.timeSignatures[0]?.timeSignature || [4, 4];
  const beatsPerMeasure = ts[0] * 4 / ts[1];

  const tracks = midi.tracks.filter(t => t.notes.length && t.channel !== 9);
  // Main droite = piste la plus aiguë ; s'il n'y a qu'une piste, on coupe au Do central.
  const means = tracks.map(t => t.notes.reduce((a, n) => a + n.midi, 0) / t.notes.length);
  const rTrack = means.indexOf(Math.max(...means));
  const all = [];
  tracks.forEach((t, ti) => t.notes.forEach(n => all.push({
    ticks: n.ticks, midi: n.midi, dur: n.durationTicks / ppq,
    hand: tracks.length > 1 ? (ti === rTrack ? 'R' : 'L') : (n.midi >= 60 ? 'R' : 'L'),
  })));
  all.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

  const steps = [];
  const tol = ppq / 16; // notes quasi simultanées = même accord
  for (const n of all) {
    const last = steps[steps.length - 1];
    if (last && n.ticks - last.ticks <= tol) {
      if (!last.notes.some(x => x.midi === n.midi)) last.notes.push({ midi: n.midi, hand: n.hand, dur: n.dur });
    } else {
      const t = n.ticks / ppq;
      steps.push({ ticks: n.ticks, t, measure: Math.floor(t / beatsPerMeasure + 1e-6),
        notes: [{ midi: n.midi, hand: n.hand, dur: n.dur }] });
    }
  }
  const title = (midi.name || '').trim();
  return { title, steps, beatsPerMeasure };
}

// ---------- MusicXML (via OpenSheetMusicDisplay déjà chargé) ----------
export function stepsFromOsmd(osmd) {
  const cursor = osmd.cursor;
  const staves = [];
  osmd.Sheet.Instruments.forEach(ins => ins.Staves.forEach(s => staves.push(s)));
  const handOf = note => {
    if (staves.length < 2) return 'R';
    const staff = note.ParentStaffEntry?.ParentStaff;
    return staves.indexOf(staff) === 0 ? 'R' : 'L';
  };
  const steps = [];
  let beatsPerMeasure = 4;
  cursor.reset();
  let idx = 0;
  while (!cursor.Iterator.EndReached && idx < 20000) {
    const it = cursor.Iterator;
    const notes = [];
    for (const note of cursor.NotesUnderCursor()) {
      if (note.isRest() || !note.Pitch) continue;
      if (note.ParentVoiceEntry?.IsGrace) continue;
      if (note.NoteTie && note.NoteTie.StartNote !== note) continue; // suite d'une liaison : ne se rejoue pas
      const midi = note.halfTone + 12;
      if (notes.some(n => n.midi === midi)) continue;
      const finger = note.Fingering?.value || note.Fingering?.Value || '';
      const dur = (note.NoteTie ? note.NoteTie.Duration?.RealValue ?? note.Length.RealValue : note.Length.RealValue) * 4;
      notes.push({ midi, hand: handOf(note), dur, finger: String(finger).trim() });
    }
    const measureIdx = it.CurrentMeasureIndex;
    const m = it.CurrentMeasure;
    if (m?.ActiveTimeSignature) beatsPerMeasure = m.ActiveTimeSignature.RealValue * 4;
    if (notes.length) {
      steps.push({ t: it.currentTimeStamp.RealValue * 4, measure: measureIdx, notes, cursorIndex: idx });
    }
    cursor.next();
    idx++;
  }
  cursor.reset();
  return { steps, beatsPerMeasure };
}

// Étendue du morceau → plage de clavier à afficher (octaves entières, 2 min.)
export function keyRange(steps) {
  let lo = 127, hi = 0;
  for (const s of steps) for (const n of s.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  if (lo > hi) { lo = 48; hi = 83; }
  lo = Math.max(21, lo - (lo % 12));            // Do en dessous
  hi = Math.min(108, hi + (11 - (hi % 12)));    // Si au-dessus
  while (hi - lo < 35) { if (lo > 21) lo = Math.max(21, lo - 12); else hi = Math.min(108, hi + 12); if (lo === 21 && hi === 108) break; }
  return [lo, hi];
}
