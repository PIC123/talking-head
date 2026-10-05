/** Rear-camera feed with low-resolution frame grabs for detection. */
export class CameraFeed {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private work: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;

  constructor(video: HTMLVideoElement, width = 320, height = 240) {
    this.video = video;
    this.width = width;
    this.height = height;
    this.work = document.createElement('canvas');
    this.work.width = width;
    this.work.height = height;
    this.ctx = this.work.getContext('2d', { willReadFrequently: true })!;
  }

  async open(): Promise<void> {
    if (this.stream) return;
    const tryGet = (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c);
    try {
      this.stream = await tryGet({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch {
      this.stream = await tryGet({ video: true, audio: false });
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    // Wait for real frames.
    await new Promise<void>((resolve) => {
      const check = () => (this.video.videoWidth > 0 ? resolve() : requestAnimationFrame(check));
      check();
    });
    // Best effort: steady exposure so a black frame and a dot frame are comparable.
    const track = this.stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual' } as MediaTrackConstraintSet] });
    } catch {
      /* not supported on most browsers; fine */
    }
  }

  get label(): string {
    return this.stream?.getVideoTracks()[0]?.label ?? '';
  }

  /** Grab the current frame, letterboxed to the work size (aspect preserved). */
  grab(): ImageData {
    const vw = this.video.videoWidth || this.width, vh = this.video.videoHeight || this.height;
    const s = Math.min(this.width / vw, this.height / vh);
    const dw = vw * s, dh = vh * s;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.drawImage(this.video, (this.width - dw) / 2, (this.height - dh) / 2, dw, dh);
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
