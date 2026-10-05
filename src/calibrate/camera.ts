/** Rear-camera feed with low-resolution frame grabs for detection, plus zoom (optical if available, else a centre crop). */
export class CameraFeed {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private work: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** Digital (crop) factor applied in grab(). */
  private crop = 1;
  /** Optical zoom actually applied on the track. */
  private optical = 1;
  private opticalMax = 1;

  constructor(video: HTMLVideoElement, width = 480, height = 360) {
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
      this.stream = await tryGet({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
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
    const track = this.stream.getVideoTracks()[0];
    const caps = (track.getCapabilities?.() ?? {}) as { zoom?: { min: number; max: number } };
    this.opticalMax = caps.zoom?.max ?? 1;
    // Best effort: steady exposure so a black frame and a lit frame are comparable.
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual' } as MediaTrackConstraintSet] });
    } catch {
      /* not supported on most browsers; fine */
    }
  }

  get label(): string {
    return this.stream?.getVideoTracks()[0]?.label ?? '';
  }

  /** Size of the raw frame the browser delivers. */
  get sourceSize(): string {
    return `${this.video.videoWidth}x${this.video.videoHeight}`;
  }

  get zoom(): number {
    return this.optical * this.crop;
  }

  /** Total zoom factor: optical up to what the camera allows, the rest as a centre crop. */
  async setZoom(z: number): Promise<string> {
    z = Math.max(1, z);
    const track = this.stream?.getVideoTracks()[0];
    let optical = 1;
    if (track && this.opticalMax > 1) {
      optical = Math.min(z, this.opticalMax);
      try {
        await track.applyConstraints({ advanced: [{ zoom: optical } as MediaTrackConstraintSet] });
      } catch {
        optical = 1;
      }
    }
    this.optical = optical;
    this.crop = z / optical;
    return optical > 1 ? `optical ${optical.toFixed(1)}x${this.crop > 1.01 ? ` + crop ${this.crop.toFixed(1)}x` : ''}` : `crop ${this.crop.toFixed(1)}x`;
  }

  /** Grab the current frame (centre-cropped by the digital zoom), letterboxed to the work size. */
  grab(): ImageData {
    const vw = this.video.videoWidth || this.width, vh = this.video.videoHeight || this.height;
    const sw = vw / this.crop, sh = vh / this.crop;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    const s = Math.min(this.width / sw, this.height / sh);
    const dw = sw * s, dh = sh * s;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.drawImage(this.video, sx, sy, sw, sh, (this.width - dw) / 2, (this.height - dh) / 2, dw, dh);
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }

  /** Draw the current (zoomed) frame onto a canvas, for the live preview. */
  preview(target: CanvasRenderingContext2D, w: number, h: number): void {
    const img = this.grab();
    const tmp = this.work; // already holds the frame
    void img;
    target.drawImage(tmp, 0, 0, w, h);
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
