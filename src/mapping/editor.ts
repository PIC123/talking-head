import type { ConfigStore } from '../config/store';
import type { Config } from '../config/schema';
import { assignDeep, defaultConfig } from '../config/schema';

export type Stage = 1 | 2 | 3 | 4;
const STAGE_NAMES: Record<Stage, string> = { 1: 'transform', 2: 'corner pin', 3: 'ellipse mask', 4: 'output' };

/**
 * Edit-mode interaction: corner-pin handles, keyboard nudges, per-stage reset, undo/redo.
 * The numeric panel (tweakpane) lives in ui/panel.ts; this only handles the direct-manipulation bits.
 */
export class MappingEditor {
  stage: Stage = 1;
  selected = 0; // corner index
  private handles: HTMLDivElement[] = [];
  private undoStack: Config['mapping'][] = [];
  private redoStack: Config['mapping'][] = [];
  private dragging: { idx: number; ox: number; oy: number } | null = null;

  constructor(
    private store: ConfigStore,
    overlay: HTMLElement,
    private hud: HTMLElement,
  ) {
    for (let i = 0; i < 4; i++) {
      const h = document.createElement('div');
      h.className = 'handle';
      h.dataset.idx = String(i);
      h.addEventListener('pointerdown', (e) => this.onHandleDown(e, i));
      overlay.appendChild(h);
      this.handles.push(h);
    }
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    window.addEventListener('resize', () => this.layout());
    store.onChange(() => this.layout());
    this.layout();
  }

  setStage(s: Stage): void {
    this.stage = s;
    document.body.classList.remove('stage-1', 'stage-2', 'stage-3', 'stage-4');
    document.body.classList.add(`stage-${s}`);
    this.layout();
  }

  layout(): void {
    const pts = this.store.cfg.mapping.cornerPin;
    this.handles.forEach((h, i) => {
      h.style.left = `${pts[i][0] * window.innerWidth}px`;
      h.style.top = `${pts[i][1] * window.innerHeight}px`;
      h.classList.toggle('selected', i === this.selected);
    });
    this.updateHud();
  }

  updateHud(extra = ''): void {
    const m = this.store.cfg.mapping;
    const t = m.transform;
    const lines = [
      `EDIT  stage ${this.stage}: ${STAGE_NAMES[this.stage]}   (1-4 stage, R reset, Z/Y undo/redo, T test, E exit)`,
      `xform x${t.x} y${t.y} s${t.scale.toFixed(3)} rot${t.rotation.toFixed(1)} ${t.flipH ? 'H' : '-'}${t.flipV ? 'V' : '-'}   pin[${this.selected}] ${m.cornerPin[this.selected].map((v) => v.toFixed(3)).join(',')}`,
      extra,
    ];
    this.hud.textContent = lines.filter(Boolean).join('\n');
  }

  /** Snapshot before a discrete change so it can be undone. */
  pushUndo(): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.store.cfg.mapping)));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.parse(JSON.stringify(this.store.cfg.mapping)));
    assignDeep(this.store.cfg.mapping, prev);
    this.store.touch();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.parse(JSON.stringify(this.store.cfg.mapping)));
    assignDeep(this.store.cfg.mapping, next);
    this.store.touch();
  }

  resetStage(): void {
    this.pushUndo();
    const d = defaultConfig().mapping;
    const m = this.store.cfg.mapping;
    if (this.stage === 1) assignDeep(m.transform, d.transform);
    else if (this.stage === 2) assignDeep(m.cornerPin, d.cornerPin);
    else if (this.stage === 3) assignDeep(m.ellipseMask, d.ellipseMask);
    else assignDeep(m.output, d.output);
    this.store.touch();
  }

  /** Arrow-key nudge in px (already multiplied by 10 for shift). */
  nudge(dx: number, dy: number): void {
    const m = this.store.cfg.mapping;
    this.pushUndo();
    if (this.stage === 1) {
      m.transform.x += dx;
      m.transform.y += dy;
    } else if (this.stage === 2) {
      const p = m.cornerPin[this.selected];
      p[0] += dx / window.innerWidth;
      p[1] += dy / window.innerHeight;
    } else if (this.stage === 3) {
      m.ellipseMask.cx += dx / window.innerWidth;
      m.ellipseMask.cy += dy / window.innerHeight;
    } else {
      m.output.hotspot.cx += dx / window.innerWidth;
      m.output.hotspot.cy += dy / window.innerHeight;
    }
    this.store.touch();
  }

  selectCorner(i: number): void {
    this.selected = ((i % 4) + 4) % 4;
    this.layout();
  }

  private onHandleDown(e: PointerEvent, idx: number): void {
    e.preventDefault();
    this.pushUndo();
    this.selected = idx;
    const p = this.store.cfg.mapping.cornerPin[idx];
    this.dragging = { idx, ox: e.clientX - p[0] * window.innerWidth, oy: e.clientY - p[1] * window.innerHeight };
    this.layout();
  }

  private onMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const p = this.store.cfg.mapping.cornerPin[this.dragging.idx];
    p[0] = (e.clientX - this.dragging.ox) / window.innerWidth;
    p[1] = (e.clientY - this.dragging.oy) / window.innerHeight;
    this.store.touch();
  }

  private onUp(): void {
    this.dragging = null;
  }
}
