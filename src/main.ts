import { ConfigStore, downloadText } from './config/store';
import { SessionManager } from './agent/session';
import { BehaviorEngine } from './behavior/engine';
import { FaceRenderer } from './face/renderer';
import { drawTestPattern } from './face/testPattern';
import { OutputStage } from './mapping/output';
import { MappingEditor, type Stage } from './mapping/editor';
import { createLog } from './ui/log';
import { createPanel } from './ui/panel';
import { keepAwake, requestFullscreen, showStartOverlay } from './ui/start';
import { Underlay } from './ui/underlay';
import { Sync } from './sync';
import { copyLog, runDiagnostics } from './ui/diagnostics';
import personaMd from '../config/persona.md?raw';

const params = new URLSearchParams(location.search);
/** ?control turns this tab into a remote for the face window open in the same browser. */
const isControl = params.has('control');
/** ?debug: face plus a phone-readable log, self-test and copy button. No panel. */
const isDebug = params.has('debug') && !isControl;

const store = new ConfigStore();

// Agent ID can come from the URL (?agent=...) for kiosk launches, or from a build-time env
// (VITE_ELEVENLABS_AGENT_ID) as a default. localStorage still wins once set in the panel.
{
  const fromUrl = params.get('agent');
  const fromEnv = import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined;
  if (fromUrl) {
    store.cfg.agent.agentId = fromUrl;
    store.cfg.agent.provider = 'elevenlabs';
    store.touch();
  } else if (fromEnv && !store.cfg.agent.agentId) {
    store.cfg.agent.agentId = fromEnv;
    store.cfg.agent.provider = 'elevenlabs';
    store.touch();
  }
  // ?muse switches to the Meta Muse relay provider (optionally ?relay=ws://host:port).
  if (params.has('muse')) {
    store.cfg.agent.provider = 'muse';
    if (params.get('relay')) store.cfg.agent.relayUrl = params.get('relay')!;
    store.touch();
  }
  // ?ws forces the WebSocket transport, ?rtc forces WebRTC (otherwise auto).
  if (params.has('ws') || params.has('rtc')) {
    store.cfg.agent.connection = params.has('ws') ? 'websocket' : 'webrtc';
    store.touch();
  }
}

const logEl = document.getElementById('log')!;
const localLog = createLog(logEl);
const sync = new Sync(isControl ? 'control' : 'face');
// The face window forwards its log to the control tab so errors and transcripts are readable there.
const log: typeof localLog = (kind, text) => {
  localLog(kind, text);
  if (!isControl) sync.send({ type: 'log', kind, text });
};

const session = new SessionManager(() => store.cfg, log);
// The persona lives in config/persona.md. Sent as a prompt override only if the ElevenLabs
// agent allows overrides; otherwise paste it into the dashboard (see README).
session.setPersonaPrompt(import.meta.env.VITE_PROMPT_OVERRIDE === '1' ? personaMd : undefined);

const face = new FaceRenderer();
const behavior = new BehaviorEngine();
const out = new OutputStage(document.getElementById('out') as HTMLCanvasElement);
const editor = new MappingEditor(store, document.getElementById('overlay')!, document.getElementById('hud')!);
const underlay = new Underlay(store);

let editMode = false;
let testPattern = false;
let panel: ReturnType<typeof createPanel> | null = null;
let fps = 0;
let fpsAcc = 0;
let fpsN = 0;

function setEditMode(on: boolean): void {
  editMode = on;
  document.body.classList.toggle('edit', on);
  document.body.classList.toggle('show', !on && !isControl);
  if (on && !panel) {
    panel = createPanel(store, {
      // The control tab never runs a session; the face rebuilds its own when the synced config changes.
      onAgentChanged: () => !isControl && session.rebuild(),
      onFullscreen: () => void requestFullscreen(),
      onPickUnderlay: () => void underlay.pick().then(() => sync.send({ type: 'underlay' })),
      onClearUnderlay: () => {
        underlay.clear();
        sync.send({ type: 'underlay' });
      },
    });
  }
  showPanel(on);
}

/** Once a control tab is driving, keep the panel off the projection; handles and HUD still show. */
function showPanel(on: boolean): void {
  const visible = on && !(!isControl && sync.peerSeen);
  document.getElementById('panel')!.classList.toggle('on', visible);
}

// ---------------- Cross-tab sync
store.setBroadcaster((cfg) => sync.send({ type: 'config', cfg }));
sync.on((m) => {
  switch (m.type) {
    case 'hello':
      if (!isControl && m.role === 'control') {
        showPanel(editMode);
        sync.send({ type: 'config', cfg: store.cfg });
        sync.send({ type: 'ui', editMode, testPattern, stage: editor.stage, selected: editor.selected });
      }
      break;
    case 'config': {
      const agentKey = (a: typeof store.cfg.agent) => JSON.stringify({ ...a, paused: undefined });
      const agentBefore = agentKey(store.cfg.agent);
      store.applyRemote(m.cfg);
      if (!isControl && agentKey(store.cfg.agent) !== agentBefore) session.rebuild();
      break;
    }
    case 'ui':
      if (m.editMode !== undefined) setEditMode(isControl ? true : m.editMode);
      if (m.testPattern !== undefined) testPattern = m.testPattern;
      if (m.stage !== undefined) editor.setStage(m.stage as Stage);
      if (m.selected !== undefined) editor.selectCorner(m.selected);
      break;
    case 'talk':
      if (!isControl) m.on ? session.pressTalk() : session.releaseTalk();
      break;
    case 'underlay':
      underlay.reload();
      break;
    case 'status':
      if (isControl) editor.updateHud(m.hud);
      break;
    case 'log':
      if (isControl) localLog(m.kind, m.text);
      break;
  }
});

function togglePause(): void {
  store.cfg.agent.paused = !store.cfg.agent.paused;
  store.touch();
  log('info', store.cfg.agent.paused ? 'PAUSED: no sessions will be opened (no credits used)' : 'resumed');
}

/** In the control tab, talk and overlay keys act on the face window instead of here. */
const talkBtn = document.getElementById('talk') as HTMLButtonElement;
const talkPress = () => {
  talkBtn.classList.add('held');
  isControl ? sync.send({ type: 'talk', on: true }) : session.pressTalk();
};
const talkRelease = () => {
  talkBtn.classList.remove('held');
  isControl ? sync.send({ type: 'talk', on: false }) : session.releaseTalk();
};
let remoteEdit = false;

// A visible hold-to-talk button (edit mode and control tab) for mouse, touch and anyone who
// has not read the placard.
talkBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  talkBtn.setPointerCapture(e.pointerId);
  talkPress();
});
for (const ev of ['pointerup', 'pointercancel'] as const) {
  talkBtn.addEventListener(ev, (e) => {
    e.stopPropagation();
    talkRelease();
  });
}
talkBtn.addEventListener('keydown', (e) => e.preventDefault()); // Space/Enter must not "click" it
talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// Keep the keyboard on the stage: after any click that is not into a text field, drop focus so
// Space reaches the talk handler instead of a panel button or slider.
window.addEventListener('pointerup', () => {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && !isTextField(a)) a.blur();
});

// ---------------- Keyboard map
const isTextField = (t: HTMLElement) =>
  (t.tagName === 'INPUT' && !['button', 'checkbox', 'range', 'color', 'submit'].includes((t as HTMLInputElement).type)) ||
  t.tagName === 'TEXTAREA' ||
  t.tagName === 'SELECT' ||
  t.isContentEditable;
const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && isTextField(t);
};

const isTalkKey = (code: string) =>
  code === 'Space' || store.cfg.agent.talkKeys.split(',').map((k) => k.trim()).filter(Boolean).includes(code);
let toggledOn = false;
/** Hold mode: press/release follow the key. Toggle mode: one press starts, the next stops. */
const talkKeyDown = () => {
  if (!store.cfg.agent.talkToggle) return talkPress();
  toggledOn = !toggledOn;
  toggledOn ? talkPress() : talkRelease();
};
const talkKeyUp = () => {
  if (!store.cfg.agent.talkToggle) talkRelease();
};

window.addEventListener('keydown', (e) => {
  if (isTalkKey(e.code)) {
    if (isTyping(e)) return;
    e.preventDefault();
    if (!e.repeat) talkKeyDown();
    return;
  }
  if (isTyping(e)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const step = e.shiftKey ? 10 : 1;
  const m = store.cfg.mapping;
  switch (e.code) {
    case 'KeyE':
      if (isControl) {
        remoteEdit = !remoteEdit;
        sync.send({ type: 'ui', editMode: remoteEdit });
      } else setEditMode(!editMode);
      break;
    case 'KeyT':
      testPattern = !testPattern;
      sync.send({ type: 'ui', testPattern });
      break;
    case 'KeyF':
      void requestFullscreen();
      break;
    case 'KeyU':
      store.cfg.underlay.visible = !store.cfg.underlay.visible;
      store.touch();
      break;
    case 'KeyP':
      togglePause();
      break;
    case 'KeyH':
      editor.pushUndo();
      m.transform.flipH = !m.transform.flipH;
      store.touch();
      break;
    case 'KeyV':
      editor.pushUndo();
      m.transform.flipV = !m.transform.flipV;
      store.touch();
      break;
    case 'KeyR':
      if (editMode) editor.resetStage();
      break;
    case 'KeyZ':
      if (ctrl) {
        e.preventDefault();
        e.shiftKey ? editor.redo() : editor.undo();
      }
      break;
    case 'KeyY':
      if (ctrl) {
        e.preventDefault();
        editor.redo();
      }
      break;
    case 'KeyS':
      if (ctrl) {
        e.preventDefault();
        downloadText('talking-head-config.json', store.exportJson());
      }
      break;
    case 'Tab':
      if (editMode && editor.stage === 2) {
        e.preventDefault();
        editor.selectCorner(editor.selected + (e.shiftKey ? -1 : 1));
        sync.send({ type: 'ui', selected: editor.selected });
      }
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!editMode) return;
      e.preventDefault();
      const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
      const dy = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
      editor.nudge(dx, dy);
      break;
    }
    case 'Equal':
    case 'Minus': {
      if (!editMode || editor.stage !== 1) return;
      editor.pushUndo();
      m.transform.scale *= e.code === 'Equal' ? 1 + 0.01 * step : 1 - 0.01 * step;
      store.touch();
      break;
    }
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4': {
      const n = Number(e.code.slice(-1));
      if (ctrl) {
        e.preventDefault();
        if (n <= 3) {
          store.savePreset(n);
          log('info', `saved preset ${n}`);
        }
      } else if (e.altKey) {
        e.preventDefault();
        if (n <= 3) log('info', store.loadPreset(n) ? `loaded preset ${n}` : `preset ${n} is empty`);
      } else if (editMode) {
        editor.setStage(n as Stage);
        sync.send({ type: 'ui', stage: n });
      }
      break;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (isTalkKey(e.code)) talkKeyUp();
});
// Never leave the mic open if the key-up is lost (window blur, fullscreen change); toggle mode keeps going.
window.addEventListener('blur', () => {
  if (!store.cfg.agent.talkToggle) talkRelease();
});
// Pointer-based talk: hold the right mouse button (presenter clicker), or on a touch screen
// hold a finger anywhere in show mode. Edit mode keeps touch free for the panel and handles.
window.addEventListener('contextmenu', (e) => e.preventDefault());
const isTouchTalk = (e: PointerEvent) =>
  e.pointerType === 'touch' &&
  !editMode &&
  !(e.target as HTMLElement | null)?.closest('button, #start, #debugbar, #panel, #log, .handle');
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2 || isTouchTalk(e)) {
    if (isTouchTalk(e)) e.preventDefault();
    talkPress();
  }
});
const releaseIfTalk = (e: PointerEvent) => {
  if (e.button === 2 || e.pointerType === 'touch') talkRelease();
};
window.addEventListener('pointerup', releaseIfTalk);
window.addEventListener('pointercancel', releaseIfTalk);

// ---------------- Render loop
let last = performance.now();
let statusAcc = 0;
let started = false;
function frame(now: number): void {
  const dt = Math.min(100, now - last);
  last = now;
  session.tick();

  const params = behavior.update(
    { state: session.getFaceState(), level: session.getLevel(), gaze: null, msSinceActivity: session.msSinceActivity() },
    store.cfg,
    dt,
  );
  if (testPattern) drawTestPattern(face.canvas.getContext('2d')!);
  else face.draw(params, store.cfg.face, dt);
  out.draw(face.canvas, store.cfg.mapping);

  if (!isControl && (editMode || isDebug || sync.peerSeen)) {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 500) {
      fps = Math.round((1000 * fpsN) / fpsAcc);
      fpsAcc = 0;
      fpsN = 0;
    }
    const l = session.getLevel();
    let status = `${session.isPaused() ? 'PAUSED  ' : ''}${fps} fps  state=${session.getAgentState()}  talk=${session.isTalkHeld() ? 'HELD' : '-'}  level=${l.level.toFixed(2)} mouth=${params.mouthOpen.toFixed(2)}  idle=${Math.round(session.msSinceActivity() / 1000)}s`;
    if (!started) status += '\nFACE WINDOW NOT STARTED: click Start there first, or its audio stays blocked';
    if (editMode || isDebug) editor.updateHud(status);
    statusAcc += dt;
    if (statusAcc >= 250 && sync.peerSeen) {
      statusAcc = 0;
      sync.send({ type: 'status', hud: status });
    }
  }
  requestAnimationFrame(frame);
}

// Handy in the console and for tests: th.store.cfg, th.editor.
(window as unknown as { th: unknown }).th = { store, editor, session, sync };

// ---------------- Boot
window.addEventListener('error', (e) => log('err', `uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log('err', `unhandled: ${String(e.reason)}`));

if (isDebug) {
  document.body.classList.add('debug');
  document.getElementById('dbg-run')!.addEventListener('click', () => void runDiagnostics(store.cfg, log));
  document.getElementById('dbg-copy')!.addEventListener('click', async () => {
    const ok = await copyLog(logEl);
    log('info', ok ? 'log copied to clipboard' : 'copy failed; long-press the log to select it');
  });
  document.getElementById('dbg-pause')!.addEventListener('click', togglePause);
  document.getElementById('dbg-reconnect')!.addEventListener('click', () => {
    session.rebuild();
    session.pressTalk();
    window.setTimeout(() => session.releaseTalk(), 300);
  });
}

if (isControl) {
  // Remote: no audio, no fullscreen, panel always on, preview of the face behind it.
  document.getElementById('start')?.remove();
  document.body.classList.add('control');
  setEditMode(true);
  if (!sync.available) log('err', 'BroadcastChannel unavailable; open the control tab in the same browser as the face');
  else {
    log('info', 'control tab ready; open the face window in another window of this browser');
    window.setTimeout(() => {
      if (!sync.peerSeen) {
        log('err', 'no face window found. Open the plain URL (no ?control) in another window of this browser, click Start there, then use this tab.');
        editor.updateHud('NO FACE WINDOW DETECTED');
      }
    }, 2500);
  }
  requestAnimationFrame(frame);
} else {
  setEditMode(false);
  requestAnimationFrame(frame); // idle face runs behind the Start overlay too.
  showStartOverlay(() => {
    started = true;
    keepAwake();
    session.start();
    if (params.has('edit')) setEditMode(true);
    if (isDebug) void runDiagnostics(store.cfg, log);
    else if (!params.has('windowed')) void requestFullscreen();
  });
}
