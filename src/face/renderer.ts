import type { Config } from '../config/schema';
import type { FaceParams } from '../behavior/engine';
import { clamp01, lerp } from '../util/math';

export const FACE_SIZE = 1024;

/**
 * Draws the face into a 1024x1024 offscreen canvas. Pure black background, glowing strokes.
 * Knows nothing about the projector or warping.
 */
export class FaceRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: { x: number; y: number; vx: number; vy: number; life: number }[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = FACE_SIZE;
    this.canvas.height = FACE_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(p: FaceParams, cfg: Config['face'], dtMs: number): void {
    const ctx = this.ctx;
    const L = cfg.layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
    ctx.translate(FACE_SIZE / 2, FACE_SIZE / 2);

    const alpha = clamp01(cfg.brightness * p.brightness);
    const glow = cfg.glow * p.glow;
    const lw = cfg.lineWidth;

    // Additive so overlapping glows add up like light.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strokePath = (build: () => void, width = lw, a = alpha) => {
      // Pass 1: soft glow. Pass 2: crisp core.
      ctx.beginPath();
      build();
      ctx.strokeStyle = cfg.color;
      ctx.globalAlpha = a * 0.55;
      ctx.lineWidth = width * 2.2;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = glow;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = a;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const fillPath = (build: () => void, a = alpha) => {
      ctx.beginPath();
      build();
      ctx.fillStyle = cfg.color;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = glow * 0.6;
      ctx.globalAlpha = a;
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    // --- Eyes
    const eyeR = L.eyeSize;
    const eyes: { cx: number; open: number; brow: number; side: number }[] = [
      { cx: -L.eyeSpacing / 2, open: p.eyeOpenL, brow: p.browL, side: -1 },
      { cx: L.eyeSpacing / 2, open: p.eyeOpenR, brow: p.browR, side: 1 },
    ];
    for (const e of eyes) {
      const cy = L.eyeY;
      const h = eyeR * 0.42 * Math.max(0.02, e.open);
      const almond = () => {
        ctx.moveTo(e.cx - eyeR, cy);
        ctx.quadraticCurveTo(e.cx, cy - h * 2, e.cx + eyeR, cy);
        ctx.quadraticCurveTo(e.cx, cy + h * 2, e.cx - eyeR, cy);
      };
      strokePath(almond);
      if (e.open > 0.08) {
        // Pupil clipped to the almond so it disappears behind the lid.
        ctx.save();
        ctx.beginPath();
        almond();
        ctx.clip();
        const pr = eyeR * 0.27 * p.pupilScale;
        const px = e.cx + p.pupilX * eyeR * 0.45;
        const py = cy + p.pupilY * h * 0.7;
        fillPath(() => ctx.arc(px, py, pr, 0, Math.PI * 2));
        // Catchlight
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha * 0.9;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(px - pr * 0.4, py - pr * 0.4, pr * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'lighter';
        ctx.restore();
      }

      // Brow: an arc above the eye; furrow tilts the inner end down.
      const by = cy - eyeR * 0.55 - L.browOffset - e.brow;
      const inner = e.side; // inner end is toward the center
      const furrowTilt = p.browFurrow * 14;
      strokePath(() => {
        const x0 = e.cx - eyeR * 1.05;
        const x1 = e.cx + eyeR * 1.05;
        const y0 = by + (inner < 0 ? furrowTilt : 0);
        const y1 = by + (inner > 0 ? furrowTilt : 0);
        ctx.moveTo(x0, y0 + 6);
        ctx.quadraticCurveTo(e.cx, by - eyeR * 0.35 - p.browFurrow * 4, x1, y1 + 6);
      }, lw * 1.1);
    }

    // --- Nose hint (optional)
    if (cfg.showNose) {
      strokePath(() => {
        ctx.moveTo(-14, L.mouthY - 110);
        ctx.quadraticCurveTo(-4, L.mouthY - 70, 16, L.mouthY - 80);
      }, lw * 0.8, alpha * 0.6);
    }

    // --- Mouth: upper and lower lip curves meeting at the corners.
    const mw = (L.mouthWidth / 2) * lerp(0.85, 1, p.mouthWidth);
    const open = p.mouthOpen * 90;
    const corner = -p.mouthSmile * 55; // negative = corners up (canvas y is down)
    const my = L.mouthY;
    strokePath(() => {
      ctx.moveTo(-mw, my + corner);
      ctx.quadraticCurveTo(0, my - open * 0.45 - corner * 0.6, mw, my + corner);
      ctx.moveTo(-mw, my + corner);
      ctx.quadraticCurveTo(0, my + open * 0.9 - corner * 0.6 + 3, mw, my + corner);
    });
    if (open > 8) {
      // Faint inner fill so an open mouth reads as a cavity, not two lines.
      fillPath(() => {
        ctx.moveTo(-mw, my + corner);
        ctx.quadraticCurveTo(0, my - open * 0.45 - corner * 0.6, mw, my + corner);
        ctx.quadraticCurveTo(0, my + open * 0.9 - corner * 0.6 + 3, -mw, my + corner);
      }, alpha * 0.12);
    }

    // --- Face contour (optional)
    if (cfg.showContour) {
      strokePath(() => ctx.ellipse(0, 20, 340, 420, 0, 0, Math.PI * 2), lw * 0.8, alpha * 0.5);
    }

    // --- Thinking shimmer: a few slow particles drifting up.
    this.updateParticles(p.shimmer, dtMs);
    if (this.particles.length) {
      ctx.fillStyle = cfg.color;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = glow * 0.5;
      for (const q of this.particles) {
        ctx.globalAlpha = alpha * 0.7 * Math.sin(Math.PI * q.life) * p.shimmer;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private updateParticles(shimmer: number, dtMs: number): void {
    const dt = dtMs / 1000;
    if (shimmer > 0.05 && this.particles.length < 24 && Math.random() < shimmer * 0.5) {
      const a = Math.random() * Math.PI * 2;
      const r = 300 + Math.random() * 120;
      this.particles.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.9, vx: (Math.random() - 0.5) * 20, vy: -20 - Math.random() * 30, life: 0 });
    }
    for (const q of this.particles) {
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.life += dt / 2.5;
    }
    this.particles = this.particles.filter((q) => q.life < 1);
  }
}
