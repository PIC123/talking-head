import { FACE_SIZE } from './renderer';

/** White grid + crosshair + circle, drawn in face space so it goes through the same warp as the face. */
export function drawTestPattern(ctx: CanvasRenderingContext2D): void {
  const S = FACE_SIZE;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const v = (i / 8) * S;
    ctx.moveTo(v, 0);
    ctx.lineTo(v, S);
    ctx.moveTo(0, v);
    ctx.lineTo(S, v);
  }
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(S / 2, 0);
  ctx.lineTo(S / 2, S);
  ctx.moveTo(0, S / 2);
  ctx.lineTo(S, S / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffb400';
  ctx.strokeRect(2, 2, S - 4, S - 4);
  // Orientation marker so flips are obvious: arrow points up, "L" at left.
  ctx.fillStyle = '#ffb400';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText('L', 30, S / 2 - 20);
  ctx.beginPath();
  ctx.moveTo(S / 2, 40);
  ctx.lineTo(S / 2 - 30, 100);
  ctx.lineTo(S / 2 + 30, 100);
  ctx.closePath();
  ctx.fill();
}
