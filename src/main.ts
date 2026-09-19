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
import personaMd from '../config/persona.md?raw';

const store = new ConfigStore();

// Agent ID can come from the URL (?agent=...) for kiosk launches, or from a build-time env
// (VITE_ELEVENLABS_AGENT_ID) as a default. localStorage still wins once set in the panel.
{
  const q = new URLSearchParams(location.search);
  const fromUrl = q.get('agent');
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
}
const log = createLog(document.getElementById('log')!);
const session = new SessionManager(() => store.cfg, log);
// The persona lives in config/persona.md. Sent as a prompt override only if the ElevenLabs
// agent allows overrides; otherwise paste it into the dashboard (see README).
session.setPersonaPrompt(import.meta.env.VITE_PROMPT_OVERRIDE === '1' ? personaMd : undefined);

const face = new FaceRenderer();
const behavior = new BehaviorEngine();
const out = new OutputStage(document.getElementById('out') as HTMLCanvasElement);
const editor = new MappingEditor(store, document.getElementById('overlay')!, document.getElementById('hud')!);

let editMode = false;
let testPattern = false;
let panel: ReturnType<typeof createPanel> | null = null;
let fps = 0;
let fpsAcc = 0;
let fpsN = 0;

function setEditMode(on: boolean): void {
  editMode = on;
  document.body.classList.toggle('edit', on);
  document.body.classList.toggle('show', !on);
  if (on && !panel) {
    panel = createPanel(store, { onAgentChanged: () => void session.rebuild(), onFullscreen: () => void requestFullscreen() });
  }
  if (panel) panel.hidden = !on;
}

// ---------------- Keyboard map
const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (isTyping(e)) return;
    e.preventDefault();
    if (!e.repeat) session.pressTalk();
    return;
  }
  if (isTyping(e)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const step = e.shiftKey ? 10 : 1;
  const m = store.cfg.mapping;
  switch (e.code) {
    case 'KeyE':
      setEditMode(!editMode);
      break;
    case 'KeyT':
      testPattern = !testPattern;
      break;
    case 'KeyF':
      void requestFullscreen();
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
      }
      break;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') session.releaseTalk();
});
// Never leave the mic open if the key-up is lost (window blur, fullscreen change).
window.addEventListener('blur', () => session.releaseTalk());
// Pointer-based talk button for touch screens / a mouse-only clicker: hold the right mouse button.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) session.pressTalk();
});
window.addEventListener('pointerup', (e) => {
  if (e.button === 2) session.releaseTalk();
});

// ---------------- Render loop
let last = performance.now();
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

  if (editMode) {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 500) {
      fps = Math.round((1000 * fpsN) / fpsAcc);
      fpsAcc = 0;
      fpsN = 0;
    }
    const l = session.getLevel();
    editor.updateHud(
      `${fps} fps  state=${session.getAgentState()}  talk=${session.isTalkHeld() ? 'HELD' : '-'}  level=${l.level.toFixed(2)} mouth=${params.mouthOpen.toFixed(2)}  idle=${Math.round(session.msSinceActivity() / 1000)}s`,
    );
  }
  requestAnimationFrame(frame);
}

// ---------------- Boot
window.addEventListener('error', (e) => log('err', `uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log('err', `unhandled: ${String(e.reason)}`));

setEditMode(false);
requestAnimationFrame(frame); // idle face runs behind the Start overlay too.
showStartOverlay(() => {
  keepAwake();
  session.start();
  if (new URLSearchParams(location.search).has('edit')) setEditMode(true);
  if (!new URLSearchParams(location.search).has('windowed')) void requestFullscreen();
});
