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
