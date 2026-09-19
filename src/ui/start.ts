/** One click to unlock audio, grant the mic, go fullscreen and hide the cursor. */
export function showStartOverlay(onStart: () => void): void {
  const el = document.getElementById('start')!;
  const btn = document.getElementById('start-btn')!;
  const go = async () => {
    btn.textContent = '...';
    try {
      // Ask for the mic once up front so the provider's own request is silent later.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('mic permission not granted yet', e);
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
