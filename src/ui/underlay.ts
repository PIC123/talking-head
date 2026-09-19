import type { ConfigStore } from '../config/store';
import { pickFile } from '../config/store';

const KEY = 'talking-head:underlay';

/**
 * Edit-mode reference photo of the surface (painting or mask), shown behind the output canvas so
 * the face layout and corner pin can be aligned at the desk. Never visible in show mode.
 */
export class Underlay {
  private img: HTMLImageElement;

  constructor(private store: ConfigStore) {
    this.img = document.getElementById('underlay') as HTMLImageElement;
    this.reload();
    store.onChange(() => this.apply());
  }

  /** Re-read the stored photo (another tab may have changed it). */
  reload(): void {
    try {
      const data = localStorage.getItem(KEY);
      if (data) this.img.src = data;
      else this.img.removeAttribute('src');
    } catch (e) {
      console.warn('underlay load failed', e);
    }
    this.apply();
  }

  apply(): void {
    const u = this.store.cfg.underlay;
    this.img.style.opacity = String(u.opacity);
    this.img.style.transform = `translate(-50%, -50%) translate(${u.x}px, ${u.y}px) scale(${u.scale})`;
    this.img.style.visibility = u.visible && this.img.src ? 'visible' : 'hidden';
  }

  hasImage(): boolean {
    return !!this.img.src;
  }

  async pick(): Promise<void> {
    const url = await pickImageAsDataUrl();
    if (!url) return;
    this.img.src = url;
    try {
      localStorage.setItem(KEY, url);
    } catch (e) {
      console.warn('underlay too large to persist; kept for this session only', e);
    }
    this.apply();
  }

  clear(): void {
    this.img.removeAttribute('src');
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    this.apply();
  }
}

/** Load an image file, downscale to 1600 px on the long side, return a JPEG data URL. */
function pickImageAsDataUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const img = new Image();
      const src = URL.createObjectURL(f);
      img.onload = () => {
        const max = 1600;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(src);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(null);
      img.src = src;
    };
    input.click();
  });
}

// Re-exported so the panel can offer a plain "import" without touching the class.
export { pickFile };
