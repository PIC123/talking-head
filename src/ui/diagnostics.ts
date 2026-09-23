import type { Config } from '../config/schema';
import type { Logger } from '../agent/session';

const TOKEN_URL = 'https://api.elevenlabs.io/v1/convai/conversation/token';

/**
 * Self-test for the ?debug page: environment, mic permission, and whether ElevenLabs will hand
 * out a session token for the configured agent. Mirrors what the SDK does, so its verdict is
 * the same one the real connection gets.
 */
export async function runDiagnostics(cfg: Config, log: Logger): Promise<void> {
  log('info', '--- diagnostics ---');
  log('info', `page: ${location.origin}  secure=${window.isSecureContext}  online=${navigator.onLine}`);
  log('info', `browser: ${navigator.userAgent.slice(0, 120)}`);
  log('info', `features: WebRTC=${'RTCPeerConnection' in window}  WebSocket=${'WebSocket' in window}  BroadcastChannel=${'BroadcastChannel' in window}  wakeLock=${'wakeLock' in navigator}`);

  // Mic
  try {
    const perm = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (perm) log('info', `mic permission state: ${perm.state}`);
  } catch {
    /* Safari has no permissions.query for the mic */
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const label = s.getAudioTracks()[0]?.label || '(no label)';
    s.getTracks().forEach((t) => t.stop());
    log('info', `mic OK: ${label}`);
  } catch (e) {
    const err = e as DOMException;
    log('err', `mic FAILED: ${err.name}: ${err.message}. ${micHint(err.name)}`);
  }

  // Agent
  const a = cfg.agent;
  log('info', `agent config: provider=${a.provider} turn=${a.turnMode} connection=${a.connection} id=${a.agentId ? a.agentId.slice(0, 12) + '…' : '(EMPTY)'}`);
  if (a.provider === 'muse') {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(a.relayUrl);
      const t = setTimeout(() => { ws.close(); log('err', `relay at ${a.relayUrl} did not answer in 3 s. Start it with: npm run relay (or npm run relay:mock)`); resolve(); }, 3000);
      ws.onopen = () => { clearTimeout(t); log('info', `relay OK at ${a.relayUrl}`); ws.close(); resolve(); };
      ws.onerror = () => { clearTimeout(t); log('err', `relay not reachable at ${a.relayUrl}. Start it with: npm run relay (or npm run relay:mock). From a phone, use the laptop's LAN address and HOST=0.0.0.0.`); resolve(); };
    });
    return;
  }
  if (a.provider !== 'elevenlabs') {
    log('info', 'provider is not ElevenLabs; token check skipped');
    return;
  }
  if (!a.agentId) {
    log('err', 'agent ID is empty: open the URL with ?agent=YOUR_ID or set it in the panel');
    return;
  }

  // Token: the exact request the SDK makes for a public agent over WebRTC.
  const url = `${TOKEN_URL}?agent_id=${encodeURIComponent(a.agentId)}&source=js_sdk`;
  try {
    const t0 = performance.now();
    const res = await fetch(url);
    const ms = Math.round(performance.now() - t0);
    const body = (await res.text()).slice(0, 300);
    if (res.ok) {
      log('info', `ElevenLabs token: OK (${res.status}, ${ms} ms). The agent is public and reachable. Credits are only checked when a conversation starts, so press talk to test that.`);
    } else {
      log('err', `ElevenLabs token: HTTP ${res.status} (${ms} ms): ${body}`);
      log('err', tokenHint(res.status));
    }
  } catch (e) {
    log('err', `ElevenLabs token: request failed: ${String(e)}. Network or DNS problem reaching api.elevenlabs.io (or a blocker extension).`);
  }
  log('info', '--- end diagnostics ---');
}

export function micHint(name: string): string {
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'The browser is blocking the microphone for this site. Desktop Chrome: click the icon left of the address bar > Site settings > Microphone > Allow. Android Chrome: lock icon > Permissions > Microphone. iPhone Safari: "aA" menu > Website Settings > Microphone > Allow. Then reload the page.';
    case 'NotFoundError':
      return 'No microphone device was found.';
    case 'NotReadableError':
      return 'Another app or tab is holding the microphone.';
    default:
      return '';
  }
}

function tokenHint(status: number): string {
  switch (status) {
    case 401:
      return 'Meaning: the agent has authentication enabled. On elevenlabs.io open the agent > Security and turn "Enable authentication" OFF (the app has no API key on purpose).';
    case 403:
      return `Meaning: this page is not allowed to use the agent. Check the agent's Security > allowlist: it must contain "${location.hostname}" exactly, or be empty.`;
    case 402:
    case 429:
      return 'Meaning: quota or rate limit. Check remaining conversational minutes / credits on your ElevenLabs plan and any concurrency limit.';
    case 404:
      return 'Meaning: no agent with this ID. Copy the ID again from the agent page.';
    default:
      return 'Meaning: ElevenLabs refused the session; the message above is their reason.';
  }
}

/** Copy the log panel to the clipboard, with a fallback for browsers that block clipboard writes. */
export async function copyLog(el: HTMLElement): Promise<boolean> {
  const text = el.innerText;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * Classify a microphone failure: 'denied' (retrying only re-prompts), 'missing' (no device or
 * device busy), or null when the error is not about the mic at all.
 */
export function micErrorKind(e: unknown): 'denied' | 'missing' | null {
  const name = (e as { name?: string })?.name ?? '';
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  if (/NotAllowedError|PermissionDeniedError|SecurityError/.test(name) || /permission denied|not allowed by the user agent|denied permission/i.test(msg)) return 'denied';
  if (/NotFoundError|NotReadableError|OverconstrainedError|DevicesNotFoundError/.test(name) || /requested device not found|could not start audio source/i.test(msg)) return 'missing';
  return null;
}
