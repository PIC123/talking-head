import type { Config } from '../config/schema';
import { FACE_SIZE } from '../face/renderer';
import { cssCornerPin, isIdentityPin, type Pt } from './homography';

/**
 * Output stage: draws the face canvas onto the fullscreen canvas with the 2D transform,
 * ellipse mask and hotspot compensation, then corner-pins the whole canvas with a CSS
 * matrix3d (a true homography, GPU-composited, no WebGL needed).
 */
export class OutputStage {
  private ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private lastPin = '';
  private maskCanvas: HTMLCanvasElement | null = null;
  private maskKey = '';

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastPin = '';
    this.maskKey = '';
  }

  draw(face: HTMLCanvasElement, m: Config['mapping']): void {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    ctx.save();
    ctx.setTransform(this.canvas.width / W, 0, 0, this.canvas.height / H, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // Clear to transparent; the stage behind is black, and in edit mode the reference photo shows through.
    ctx.clearRect(0, 0, W, H);

    // Base fit: the 1024 face square fills the shorter screen dimension, centered.
    const base = Math.min(W, H) / FACE_SIZE;
    const t = m.transform;
    ctx.translate(W / 2 + t.x, H / 2 + t.y);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.scale(base * t.scale * t.scaleX * (t.flipH ? -1 : 1), base * t.scale * t.scaleY * (t.flipV ? -1 : 1));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = Math.max(0, Math.min(1, m.output.brightness));
    ctx.drawImage(face, -FACE_SIZE / 2, -FACE_SIZE / 2);
    ctx.restore();

    ctx.save();
    ctx.setTransform(this.canvas.width / W, 0, 0, this.canvas.height / H, 0, 0);
    if (m.ellipseMask.enabled) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.getMask(m.ellipseMask, W, H), 0, 0, W, H);
    }
    if (m.output.hotspot.enabled && m.output.hotspot.strength > 0) {
      const hs = m.output.hotspot;
      const r = hs.radius * Math.max(W, H);
      const g = ctx.createRadialGradient(hs.cx * W, hs.cy * H, 0, hs.cx * W, hs.cy * H, r);
      g.addColorStop(0, `rgba(0,0,0,${hs.strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    this.applyCornerPin(m.cornerPin as Pt[]);
  }

  private getMask(e: Config['mapping']['ellipseMask'], W: number, H: number): HTMLCanvasElement {
    const key = `${W}x${H}:${e.cx},${e.cy},${e.rx},${e.ry},${e.feather}`;
    if (this.maskCanvas && key === this.maskKey) return this.maskCanvas;
    const c = this.maskCanvas ?? document.createElement('canvas');
    c.width = Math.max(1, Math.round(W / 2));
    c.height = Math.max(1, Math.round(H / 2));
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    // Draw a unit-circle feathered gradient, scaled into the ellipse.
    g.save();
    g.translate(e.cx * c.width, e.cy * c.height);
    g.scale(Math.max(1e-3, e.rx * c.width), Math.max(1e-3, e.ry * c.height));
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    const inner = Math.max(0, 1 - e.feather * 2);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(inner, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
    this.maskCanvas = c;
    this.maskKey = key;
    return c;
  }

  private applyCornerPin(pts: Pt[]): void {
    const css = isIdentityPin(pts)
      ? 'none'
      : cssCornerPin(pts.map(([x, y]) => [x * this.width, y * this.height] as Pt), this.width, this.height);
    if (css !== this.lastPin) {
      this.canvas.style.transform = css;
      this.lastPin = css;
    }
  }
}
