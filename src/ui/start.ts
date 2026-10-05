import { micHint } from './diagnostics';

/** One click to unlock audio, grant the mic, go fullscreen and hide the cursor. */
export function showStartOverlay(onStart: () => void): void {
  const el = document.getElementById('start')!;
  const btn = document.getElementById('start-btn')!;
  const note = el.querySelector('p')!;
  let warned = false;
  const go = async () => {
    btn.textContent = '...';
    try {
      // Ask for the mic once up front so the provider's own request is silent later.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      const err = e as DOMException;
      console.warn('mic permission not granted', err);
      if (!warned) {
        // Say it here, on the screen the person is looking at, instead of failing quietly later.
        warned = true;
        note.textContent = `Microphone ${err.name}: ${err.message || ''} ${micHint(err.name)}`;
        note.style.color = '#ff6b6b';
        note.style.maxWidth = '80vw';
        note.style.textAlign = 'center';
        btn.textContent = 'Continue anyway';
        btn.addEventListener('click', go, { once: true });
        return;
      }
    }
    el.remove();
    onStart();
  };
  btn.addEventListener('click', go, { once: true });
}

export async function requestFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    else await document.exitFullscreen();
  } catch (e) {
    console.warn('fullscreen failed', e);
  }
}

/** Enter fullscreen if not already in it (never toggles out). Needs a user gesture on most browsers. */
export async function ensureFullscreen(log?: (text: string) => void): Promise<void> {
  if (document.fullscreenElement || typeof document.documentElement.requestFullscreen !== 'function') return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) {
    log?.(`fullscreen refused: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Looks fullscreen: the viewport is (nearly) the whole screen, whatever the API says. */
export function looksFullscreen(): boolean {
  return window.innerHeight >= screen.height - 2 || window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height * 0.95;
}

/**
 * Exit (if the API thinks we are in) and re-enter fullscreen within one user gesture, and report
 * what happened in a line for the UI. Used by the explicit Fullscreen button.
 */
export async function forceFullscreen(log?: (text: string) => void): Promise<string> {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== 'function') return 'fullscreen not available in this browser (iPhone: add the page to the home screen)';
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    await el.requestFullscreen({ navigationUI: 'hide' });
    await new Promise((r) => setTimeout(r, 300));
    const ok = looksFullscreen();
    const line = `fullscreen ${ok ? 'on' : 'requested, but the viewport is still'} ${window.innerWidth}×${window.innerHeight} of ${screen.width}×${screen.height}`;
    log?.(line);
    return line;
  } catch (e) {
    const line = `fullscreen refused: ${e instanceof Error ? e.message : String(e)}`;
    log?.(line);
    return line;
  }
}

/** Keep the display awake for the whole show; re-acquire after tab visibility changes. */
export function keepAwake(): void {
  let lock: WakeLockSentinel | null = null;
  const acquire = async () => {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch (e) {
      console.warn('wake lock failed', e);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !lock) void acquire();
  });
  void acquire();
}
