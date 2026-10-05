import type { ConfigStore } from '../config/store';
import type { MappingEditor } from '../mapping/editor';
import { defaultConfig, assignDeep } from '../config/schema';
import { CameraFeed, sleep } from './camera';
import { runScan, findMask, placeFace, type CalFrame, type ScanResult, type Placement } from './sweep';
import type { Region } from './detect';

export interface CalibrationHooks {
  /** Set what the projector shows; null returns to the face. */
  setFrame: (f: CalFrame | null) => void;
  outputSize: () => { W: number; H: number };
  log: (kind: 'info' | 'err', text: string) => void;
  onToggleEdit: () => void;
  /** Re-enter fullscreen (the camera permission prompt throws the browser out of it). */
  ensureFullscreen: () => Promise<void>;
  /** Exit-and-re-enter fullscreen; resolves to a status line for the menu. */
  forceFullscreen: () => Promise<string>;
}

/**
 * Phone-friendly calibration menu. The phone's screen is mirrored to the projector and its rear
 * camera watches the mask, so this one page both drives the projector and sees the result.
 * Flow: camera on -> scan (Gray-code stripes) -> tap the mask in the lit picture -> accept.
 */
export class CalibrationUI {
  readonly el: HTMLDivElement;
  private video: HTMLVideoElement;
  private pic: HTMLCanvasElement;
  private status: HTMLDivElement;
  private tolInput: HTMLInputElement;
  private sizeInput!: HTMLInputElement;
  private cam: CameraFeed | null = null;
  private scan: ScanResult | null = null;
  private placement: Placement | null = null;
  private busy = false;
  private fsPending: Promise<void> = Promise.resolve();
  private before: string | null = null;
  private btn: Record<string, HTMLButtonElement> = {};

  constructor(private store: ConfigStore, private editor: MappingEditor, private hooks: CalibrationHooks) {
    this.el = document.createElement('div');
    this.el.id = 'cal';
    this.el.innerHTML = `
      <div class="cal-head"><b>Auto calibration</b><span class="cal-x" data-act="close">✕</span></div>
      <div class="cal-status" id="cal-status">Mirror this phone to the projector, aim the camera at the mask, then start.</div>
      <div class="cal-row">
        <button data-act="camera">1 Camera on</button>
        <button data-act="sweep" disabled>2 Scan</button>
      </div>
      <div class="cal-row">
        <button data-act="accept" disabled>4 Accept</button>
        <button data-act="undo" disabled>Undo</button>
      </div>
      <div class="cal-pic"><video id="cal-video" playsinline muted></video><canvas id="cal-pic"></canvas></div>
      <label class="cal-zoom">camera zoom <span id="cal-zoom-v">1x</span> <input id="cal-zoom" type="range" min="1" max="4" step="0.25" value="1"></label>
      <label class="cal-tol">mask colour tolerance <input id="cal-tol" type="range" min="25" max="140" value="60"></label>
      <label class="cal-tol">face size <span id="cal-size-v">100%</span> <input id="cal-size" type="range" min="60" max="150" step="2" value="100"></label>
      <div class="cal-row cal-minor">
        <button data-act="fullscreen">Fullscreen</button>
        <button data-act="edit">Edit panel</button>
        <button data-act="hide">Hide menu</button>
      </div>`;
    this.video = this.el.querySelector('#cal-video')!;
    this.pic = this.el.querySelector('#cal-pic')!;
    this.status = this.el.querySelector('#cal-status')!;
    this.tolInput = this.el.querySelector('#cal-tol')!;
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>('button[data-act]'))) {
      this.btn[b.dataset.act!] = b;
      b.addEventListener('click', () => void this.act(b.dataset.act!));
    }
    this.el.querySelector('.cal-x')!.addEventListener('click', () => this.hide());
    // A short, still touch on the picture is a tap; a drag scrolls the menu (touch-action: pan-y).
    let down: { x: number; y: number; t: number } | null = null;
    this.pic.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.pic.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      const d = down;
      down = null;
      if (d && performance.now() - d.t < 600 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12) void this.onTap(e);
    });
    this.pic.addEventListener('pointercancel', () => (down = null));
    this.tolInput.addEventListener('change', () => this.retune());
    this.sizeInput = this.el.querySelector<HTMLInputElement>('#cal-size')!;
    this.sizeInput.addEventListener('input', () => (this.el.querySelector('#cal-size-v')!.textContent = `${this.sizeInput.value}%`));
    this.sizeInput.addEventListener('change', () => this.placeFromTap());
    const zoomInput = this.el.querySelector<HTMLInputElement>('#cal-zoom')!;
    zoomInput.addEventListener('change', () => void this.setZoom(Number(zoomInput.value)));
    zoomInput.addEventListener('input', () => (this.el.querySelector('#cal-zoom-v')!.textContent = `${Number(zoomInput.value).toFixed(2).replace(/\.?0+$/, '')}x`));
    // Outside #stage: the stage disables touch gestures for push-to-talk, and that setting also
    // applies to everything inside it, which would make this menu impossible to scroll on a phone.
    document.body.appendChild(this.el);
    // Any completed tap in the menu is a user gesture: use it to get back into fullscreen if it was
    // lost. (On touch screens only click/pointerup count as activation, not pointerdown.)
    this.el.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.cal-x, [data-act="fullscreen"]')) this.fsPending = this.hooks.ensureFullscreen();
    }, { capture: true });
  }

  get visible(): boolean {
    return this.el.classList.contains('on');
  }

  show(): void {
    this.el.classList.add('on');
    document.body.classList.add('cal');
  }

  hide(): void {
    this.el.classList.remove('on');
    document.body.classList.remove('cal');
    this.hooks.setFrame(null);
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  private say(text: string, err = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('err', err);
  }

  private async act(what: string): Promise<void> {
    if (this.busy) return;
    // Every button tap is a user gesture: use it to get back into fullscreen, which the camera
    // permission prompt (and some phones' tab switches) drop us out of. If that changes the
    // viewport, let the resize settle first so the patterns are projected at the final size.
    if (what !== 'close' && what !== 'fullscreen') {
      const was = !!document.fullscreenElement;
      await this.fsPending; // requested by the click handler above
      if (!was && document.fullscreenElement) await sleep(500);
    }
    try {
      switch (what) {
        case 'close':
          this.hide();
          break;
        case 'camera':
          await this.openCamera();
          break;
        case 'sweep':
          await this.doSweep();
          break;
        case 'accept':
          this.accept();
          break;
        case 'undo':
          this.undo();
          break;
        case 'fullscreen': {
          const r = await this.hooks.forceFullscreen();
          this.say(r);
          break;
        }
        case 'edit':
          this.hooks.onToggleEdit();
          break;
        case 'hide':
          this.hide();
          this.hooks.log('info', 'menu hidden; tap the top-right corner (or press C) to bring it back');
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.say(msg, true);
      this.hooks.log('err', `calibration: ${msg}`);
      this.hooks.setFrame(null);
    } finally {
      this.busy = false;
      document.body.classList.remove('sweeping');
    }
  }

  private async openCamera(): Promise<void> {
    this.busy = true;
    this.say('opening camera…');
    this.cam = this.cam ?? new CameraFeed(this.video);
    await this.cam.open();
    // The permission prompt exits fullscreen; the gesture that opened the camera is usually still
    // fresh enough to re-enter. The next button tap does it for sure.
    await this.hooks.ensureFullscreen();
    this.el.classList.add('live');
    this.btn.sweep.disabled = false;
    this.say(`camera: ${this.cam.label || 'ready'}. Zoom until the mask fills most of the picture, keep the phone still, then Scan.`);
    this.hooks.log('info', `calibration camera: ${this.cam.label || 'unknown'} ${this.cam.sourceSize}`);
    this.startPreview();
  }

  private previewTimer = 0;
  /** Live preview of exactly what the detector sees (zoom and crop included), ~8 fps. */
  private startPreview(): void {
    window.clearInterval(this.previewTimer);
    this.previewTimer = window.setInterval(() => {
      if (!this.cam || !this.visible || this.busy || this.el.classList.contains('lit')) return;
      this.sizePic();
      this.cam.preview(this.pic.getContext('2d')!, this.pic.width, this.pic.height);
    }, 125);
  }

  private async setZoom(z: number): Promise<void> {
    if (!this.cam) return;
    const how = await this.cam.setZoom(z);
    if (this.scan) {
      this.scan = null;
      this.placement = null;
      this.el.classList.remove('lit');
      this.btn.accept.disabled = true;
      this.say(`zoom ${z}x (${how}). Scan again.`);
    } else this.say(`zoom ${z}x (${how}). Frame the mask, then Scan.`);
    this.hooks.log('info', `camera zoom ${z}x: ${how}`);
  }

  private async doSweep(): Promise<void> {
    if (!this.cam) throw new Error('turn the camera on first');
    this.busy = true;
    this.scan = null;
    this.placement = null;
    this.region = null;
    this.lastTap = null;
    this.btn.accept.disabled = true;
    this.el.classList.remove('lit');
    if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen === 'function') this.hooks.log('err', 'scanning while not fullscreen: the projection will shift if the page goes fullscreen later');
    this.say('scanning: keep the phone still…');
    // The phone screen is the projector: hide every control while patterns are shown.
    document.body.classList.add('sweeping');
    try {
      this.scan = await runScan(this.cam, (f) => this.hooks.setFrame(f), (s) => this.say(s));
    } finally {
      document.body.classList.remove('sweeping');
      this.hooks.setFrame(null);
    }
    this.el.classList.add('lit');
    this.redrawPic();
    const r = this.scan;
    this.hooks.log('info', `scan: ${r.validCount} of ${r.width * r.height} camera pixels decoded`);
    this.say(`scan done (${Math.round((100 * r.validCount) / (r.width * r.height))}% of the picture decoded). 3: tap the middle of the mask in the picture.`);
  }

  private picScale(): number {
    return this.pic.width / (this.cam?.width ?? 320);
  }

  /** Size the picture to fit its box at the camera aspect, so taps map 1:1 onto camera pixels. */
  private sizePic(): void {
    if (!this.cam) return;
    const w = this.cam.width, h = this.cam.height;
    const boxW = this.pic.parentElement!.clientWidth || this.el.clientWidth - 24;
    const cssW = Math.max(120, Math.min(boxW, 480, (window.innerHeight * 0.42 * w) / h));
    const pw = Math.round(cssW), ph = Math.round((cssW * h) / w);
    if (this.pic.width !== pw || this.pic.height !== ph) {
      this.pic.width = pw;
      this.pic.height = ph;
      this.pic.style.width = `${pw}px`;
      this.pic.style.height = `${ph}px`;
    }
  }

  private redrawPic(region: Region | null = null): void {
    if (!this.scan || !this.cam) return;
    const w = this.cam.width, h = this.cam.height;
    this.sizePic();
    const g = this.pic.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(this.scan.lit, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, this.pic.width, this.pic.height);
    if (region) {
      const s = this.picScale();
      // Tint the found region and outline its box.
      const ov = g.createImageData(w, h);
      for (let i = 0; i < region.mask.length; i++) if (region.mask[i]) { ov.data[i * 4] = 0; ov.data[i * 4 + 1] = 200; ov.data[i * 4 + 2] = 255; ov.data[i * 4 + 3] = 110; }
      tmp.getContext('2d')!.putImageData(ov, 0, 0);
      g.drawImage(tmp, 0, 0, this.pic.width, this.pic.height);
      const b = region.bbox;
      g.strokeStyle = '#ffb400';
      g.lineWidth = 2;
      g.strokeRect(b.x0 * s, b.y0 * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    }
  }

  lastTap: [number, number] | null = null;
  private region: Region | null = null;

  private async onTap(e: PointerEvent): Promise<void> {
    if (!this.scan || this.busy) return;
    const r = this.pic.getBoundingClientRect();
    const s = this.picScale() * (r.width / this.pic.width);
    this.lastTap = [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
    this.placeFromTap();
  }

  /** Find the mask at the last tap and place the face on it (instant: the scan already coded every pixel). */
  private placeFromTap(): void {
    if (!this.scan || !this.lastTap) return;
    try {
      this.region = findMask(this.scan, this.lastTap, Number(this.tolInput.value));
      this.redrawPic(this.region);
      const { W, H } = this.hooks.outputSize();
      this.placement = placeFace(this.scan, this.region, W, H, Number(this.sizeInput.value) / 100);
      const p = this.placement, b = this.region.bbox;
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      this.hooks.log('info', `mask ${b.x1 - b.x0}×${b.y1 - b.y0} px in camera (${p.coded} coded), in projector frame x ${pct(p.rect.x0)}–${pct(p.rect.x1)} y ${pct(p.rect.y0)}–${pct(p.rect.y1)}, axis fit ${p.axisFit.toFixed(2)}, flip ${p.flipH ? 'H' : '-'}${p.flipV ? 'V' : '-'}, pin ${JSON.stringify(p.cornerPin.map((q) => q.map((v) => +v.toFixed(3))))}`);
      this.btn.accept.disabled = false;
      this.say(`mask found: ${Math.round((p.rect.x1 - p.rect.x0) * 100)}% × ${Math.round((p.rect.y1 - p.rect.y0) * 100)}% of the projector frame (${p.coded} coded pixels${p.axisFit < 0.6 ? ', weak scan' : ''}). Check the projection, adjust the tolerance if the outline is wrong, then Accept.`);
      this.preview();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.say(msg, true);
      this.hooks.log('err', `calibration: ${msg}`);
      this.placement = null;
      this.btn.accept.disabled = true;
    }
  }

  /** Apply the placement to the live config so the projector shows it; Accept keeps it, Undo reverts. */
  private preview(): void {
    if (!this.placement) return;
    if (this.before === null) {
      this.before = JSON.stringify(this.store.cfg.mapping);
      this.editor.pushUndo();
    }
    const m = this.store.cfg.mapping;
    assignDeep(m.transform, defaultConfig().mapping.transform);
    m.transform.flipH = this.placement.flipH;
    m.transform.flipV = this.placement.flipV;
    m.cornerPin = this.placement.cornerPin.map(([x, y]) => [x, y]);
    const e = this.placement.ellipse;
    Object.assign(m.ellipseMask, { enabled: true, cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, feather: Math.max(m.ellipseMask.feather, 0.08) });
    this.store.touch();
    this.btn.undo.disabled = false;
  }

  private accept(): void {
    if (!this.placement) return;
    this.preview();
    this.before = null;
    this.hooks.log('info', `calibration applied: pin ${this.placement.cornerPin.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' | ')}`);
    this.say('applied. Fine-tune in the edit panel (E) or drag the corner handles if needed.');
    this.btn.accept.disabled = true;
  }

  private undo(): void {
    if (this.before === null) return;
    assignDeep(this.store.cfg.mapping, JSON.parse(this.before));
    this.store.touch();
    this.before = null;
    this.btn.undo.disabled = true;
    this.btn.accept.disabled = true;
    this.say('reverted to the previous mapping.');
  }

  /** Tolerance slider: re-grow the mask and place again. */
  retune(): void {
    this.placeFromTap();
  }

  destroy(): void {
    this.cam?.close();
  }
}
