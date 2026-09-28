// Partition (MusicXML) rendue par OpenSheetMusicDisplay, avec curseur qui suit les étapes.
import { stepsFromOsmd } from './score.js';

const OK_COLOR = '#1f9d55';

export class Sheet {
  constructor(container, scroller) {
    this.container = container;
    this.scroller = scroller;
    this.osmd = null;
    this.cursorPos = 0;
    this.colored = [];
  }

  async load(data, format) {
    this.container.innerHTML = '';
    const OSMD = window.opensheetmusicdisplay.OpenSheetMusicDisplay;
    this.osmd = new OSMD(this.container, {
      backend: 'svg',
      autoResize: true,
      drawTitle: true,
      drawSubtitle: false,
      drawComposer: true,
      drawLyricist: false,
      drawPartNames: false,
      drawFingerings: true,
      followCursor: false,
      cursorsOptions: [{ type: 0, color: '#5aa9ff', alpha: 0.35, follow: false }],
    });
    this.osmd.zoom = window.innerWidth < 800 ? 0.75 : 1.0;
    const content = format === 'mxl'
      ? new Blob([data], { type: 'application/vnd.recordare.musicxml' })
      : new TextDecoder().decode(data);
    await this.osmd.load(content);
    this.osmd.render();
    this.osmd.cursor.show();
    const res = stepsFromOsmd(this.osmd);
    this.cursorPos = 0;
    return { ...res, title: this.osmd.Sheet.TitleString || '' };
  }

  // Déplace le curseur OSMD à la position d'itération voulue
  goTo(cursorIndex) {
    const c = this.osmd.cursor;
    if (cursorIndex < this.cursorPos) { c.reset(); this.cursorPos = 0; }
    while (this.cursorPos < cursorIndex && !c.Iterator.EndReached) { c.next(); this.cursorPos++; }
    c.update();
    this.scrollToCursor();
  }

  scrollToCursor() {
    const el = this.osmd.cursor.cursorElement;
    if (!el) return;
    const sc = this.scroller;
    const top = el.offsetTop, h = el.offsetHeight;
    const view = sc.clientHeight;
    // on garde le système en cours dans le tiers supérieur de l'écran
    if (top < sc.scrollTop + 10 || top + h > sc.scrollTop + view * 0.75) {
      sc.scrollTo({ top: Math.max(0, top - view * 0.12), behavior: 'smooth' });
    }
  }

  // Colore en vert les notes (des mains demandées) sous le curseur
  markCurrentDone(hands) {
    try {
      for (const g of this.osmd.cursor.GNotesUnderCursor()) {
        const note = g.sourceNote;
        if (!note || note.isRest()) continue;
        if (hands && !hands(note)) continue;
        g.setColor(OK_COLOR, { applyToNoteheads: true, applyToStem: true, applyToBeams: false, applyToFlag: true, applyToLedgerLines: true });
        this.colored.push(g);
      }
    } catch (e) { console.warn('coloration', e); }
  }

  resetColors() {
    for (const g of this.colored) {
      try { g.setColor('#000000', { applyToNoteheads: true, applyToStem: true, applyToFlag: true, applyToLedgerLines: true }); } catch { /* ignore */ }
    }
    this.colored = [];
  }

  // Change (ou retire si value vide) le doigté d'une note, sans redessiner
  setFinger(note, value) {
    if (!note) return;
    const ve = note.ParentVoiceEntry;
    const lib = window.opensheetmusicdisplay;
    const existing = ve.TechnicalInstructions.find(t => t.sourceNote === note && t.type === lib.TechnicalInstructionType.Fingering);
    if (value) {
      if (existing) existing.value = value;
      else {
        const t = new lib.TechnicalInstruction();
        t.type = lib.TechnicalInstructionType.Fingering;
        t.value = value;
        t.sourceNote = note;
        t.placement = 4; // placement automatique (comme les doigtés lus dans le fichier)
        ve.TechnicalInstructions.push(t);
        note.Fingering = t;
      }
    } else if (existing) {
      ve.TechnicalInstructions = ve.TechnicalInstructions.filter(t => t !== existing);
      note.Fingering = undefined;
    }
  }

  // Redessine la partition en gardant la position du curseur
  rerender() {
    const pos = this.cursorPos;
    this.osmd.render();
    this.colored = [];
    this.osmd.cursor.show();
    this.osmd.cursor.reset();
    this.cursorPos = 0;
    this.goTo(pos);
  }

  flashCursor(color) {
    const el = this.osmd?.cursor?.cursorElement;
    if (!el) return;
    el.style.transition = 'none';
    el.style.filter = color === 'bad' ? 'hue-rotate(150deg) saturate(3)' : '';
    clearTimeout(this._ft);
    this._ft = setTimeout(() => { el.style.filter = ''; }, 300);
  }
}
