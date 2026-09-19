import { Pane } from 'tweakpane';
import type { ConfigStore } from '../config/store';
import { downloadText, pickFile } from '../config/store';

export interface PanelHooks {
  onAgentChanged: () => void;
  onFullscreen: () => void;
  onPickUnderlay: () => void;
  onClearUnderlay: () => void;
}

/** tweakpane panel with every tunable. Shown in edit mode only. */
export function createPanel(store: ConfigStore, hooks: PanelHooks): Pane {
  const container = document.getElementById('panel')!;
  const pane = new Pane({ title: 'Talking Head', expanded: true, container });
  const c = store.cfg;
  const touch = () => store.touch();

  const agent = pane.addFolder({ title: 'Agent', expanded: true });
  agent.addBinding(c.agent, 'provider', { options: { 'ElevenLabs': 'elevenlabs', 'Mic loop (test)': 'micloop', 'Echo (test)': 'echo' } })
    .on('change', () => { touch(); hooks.onAgentChanged(); });
  agent.addBinding(c.agent, 'agentId').on('change', () => { touch(); hooks.onAgentChanged(); });
  agent.addBinding(c.agent, 'turnMode', { options: { 'Push to talk': 'pushToTalk', 'Open mic': 'openMic' } })
    .on('change', () => { touch(); hooks.onAgentChanged(); });
  agent.addBinding(c.agent, 'connectOnStart').on('change', () => { touch(); hooks.onAgentChanged(); });
  agent.addBinding(c.agent, 'sessionIdleTimeoutSec', { min: 10, max: 300, step: 5 }).on('change', touch);

  const face = pane.addFolder({ title: 'Face', expanded: false });
  face.addBinding(c.face, 'color').on('change', touch);
  face.addBinding(c.face, 'lineWidth', { min: 1, max: 12, step: 0.5 }).on('change', touch);
  face.addBinding(c.face, 'glow', { min: 0, max: 60, step: 1 }).on('change', touch);
  face.addBinding(c.face, 'brightness', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  face.addBinding(c.face, 'showNose').on('change', touch);
  face.addBinding(c.face, 'showContour').on('change', touch);
  const show = face.addFolder({ title: 'Features (hide what the surface already has)', expanded: false });
  show.addBinding(c.face.show, 'eyeOutline').on('change', touch);
  show.addBinding(c.face.show, 'pupils').on('change', touch);
  show.addBinding(c.face.show, 'brows').on('change', touch);
  show.addBinding(c.face.show, 'mouth').on('change', touch);
  const wash = face.addFolder({ title: 'Light wash (for paintings)', expanded: false });
  wash.addBinding(c.face.wash, 'enabled').on('change', touch);
  wash.addBinding(c.face.wash, 'color').on('change', touch);
  wash.addBinding(c.face.wash, 'opacity', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  wash.addBinding(c.face.wash, 'cx', { min: -512, max: 512, step: 1 }).on('change', touch);
  wash.addBinding(c.face.wash, 'cy', { min: -512, max: 512, step: 1 }).on('change', touch);
  wash.addBinding(c.face.wash, 'rx', { min: 20, max: 800, step: 1 }).on('change', touch);
  wash.addBinding(c.face.wash, 'ry', { min: 20, max: 800, step: 1 }).on('change', touch);
  wash.addBinding(c.face.wash, 'softness', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  wash.addBinding(c.face.wash, 'breathe', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  wash.addBinding(c.face.wash, 'speechBoost', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  const layout = face.addFolder({ title: 'Layout', expanded: true });
  layout.addBinding(c.face.layout, 'eyeSpacing', { min: 80, max: 500, step: 1 }).on('change', touch);
  layout.addBinding(c.face.layout, 'eyeY', { min: -300, max: 200, step: 1 }).on('change', touch);
  layout.addBinding(c.face.layout, 'eyeSize', { min: 20, max: 160, step: 1 }).on('change', touch);
  layout.addBinding(c.face.layout, 'browOffset', { min: 0, max: 160, step: 1 }).on('change', touch);
  layout.addBinding(c.face.layout, 'mouthY', { min: 0, max: 400, step: 1 }).on('change', touch);
  layout.addBinding(c.face.layout, 'mouthWidth', { min: 40, max: 500, step: 1 }).on('change', touch);

  const mouth = pane.addFolder({ title: 'Mouth', expanded: false });
  mouth.addBinding(c.mouth, 'gain', { min: 0.5, max: 8, step: 0.1 }).on('change', touch);
  mouth.addBinding(c.mouth, 'gate', { min: 0, max: 0.5, step: 0.01 }).on('change', touch);
  mouth.addBinding(c.mouth, 'attackMs', { min: 5, max: 200, step: 5 }).on('change', touch);
  mouth.addBinding(c.mouth, 'releaseMs', { min: 20, max: 500, step: 10 }).on('change', touch);
  mouth.addBinding(c.mouth, 'gamma', { min: 0.3, max: 2, step: 0.05 }).on('change', touch);
  mouth.addBinding(c.mouth, 'jitter', { min: 0, max: 0.3, step: 0.01 }).on('change', touch);

  const beh = pane.addFolder({ title: 'Behavior', expanded: false });
  beh.addBinding(c.behavior, 'blinkMinSec', { min: 0.5, max: 10, step: 0.5 }).on('change', touch);
  beh.addBinding(c.behavior, 'blinkMaxSec', { min: 1, max: 20, step: 0.5 }).on('change', touch);
  beh.addBinding(c.behavior, 'doubleBlinkChance', { min: 0, max: 1, step: 0.05 }).on('change', touch);
  beh.addBinding(c.behavior, 'attractAfterSec', { min: 5, max: 600, step: 5 }).on('change', touch);

  const map = pane.addFolder({ title: 'Mapping', expanded: false });
  const tr = map.addFolder({ title: '1 Transform', expanded: true });
  tr.addBinding(c.mapping.transform, 'x', { min: -2000, max: 2000, step: 1 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'y', { min: -2000, max: 2000, step: 1 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'scale', { min: 0.05, max: 4, step: 0.005 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'scaleX', { min: 0.2, max: 3, step: 0.005 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'scaleY', { min: 0.2, max: 3, step: 0.005 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'rotation', { min: -180, max: 180, step: 0.1 }).on('change', touch);
  tr.addBinding(c.mapping.transform, 'flipH').on('change', touch);
  tr.addBinding(c.mapping.transform, 'flipV').on('change', touch);
  const em = map.addFolder({ title: '3 Ellipse mask', expanded: false });
  em.addBinding(c.mapping.ellipseMask, 'enabled').on('change', touch);
  em.addBinding(c.mapping.ellipseMask, 'cx', { min: 0, max: 1, step: 0.001 }).on('change', touch);
  em.addBinding(c.mapping.ellipseMask, 'cy', { min: 0, max: 1, step: 0.001 }).on('change', touch);
  em.addBinding(c.mapping.ellipseMask, 'rx', { min: 0.01, max: 1, step: 0.001 }).on('change', touch);
  em.addBinding(c.mapping.ellipseMask, 'ry', { min: 0.01, max: 1, step: 0.001 }).on('change', touch);
  em.addBinding(c.mapping.ellipseMask, 'feather', { min: 0, max: 0.5, step: 0.005 }).on('change', touch);
  const out = map.addFolder({ title: '4 Output', expanded: false });
  out.addBinding(c.mapping.output, 'brightness', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  out.addBinding(c.mapping.output.hotspot, 'enabled').on('change', touch);
  out.addBinding(c.mapping.output.hotspot, 'cx', { min: 0, max: 1, step: 0.001 }).on('change', touch);
  out.addBinding(c.mapping.output.hotspot, 'cy', { min: 0, max: 1, step: 0.001 }).on('change', touch);
  out.addBinding(c.mapping.output.hotspot, 'radius', { min: 0.05, max: 1, step: 0.005 }).on('change', touch);
  out.addBinding(c.mapping.output.hotspot, 'strength', { min: 0, max: 1, step: 0.01 }).on('change', touch);

  const ul = pane.addFolder({ title: 'Reference photo (edit mode only)', expanded: false });
  ul.addButton({ title: 'Load photo of surface' }).on('click', hooks.onPickUnderlay);
  ul.addButton({ title: 'Clear photo' }).on('click', hooks.onClearUnderlay);
  ul.addBinding(c.underlay, 'visible').on('change', touch);
  ul.addBinding(c.underlay, 'opacity', { min: 0, max: 1, step: 0.01 }).on('change', touch);
  ul.addBinding(c.underlay, 'scale', { min: 0.1, max: 4, step: 0.005 }).on('change', touch);
  ul.addBinding(c.underlay, 'x', { min: -2000, max: 2000, step: 1 }).on('change', touch);
  ul.addBinding(c.underlay, 'y', { min: -2000, max: 2000, step: 1 }).on('change', touch);

  const io = pane.addFolder({ title: 'Config', expanded: true });
  io.addButton({ title: 'Export JSON (Ctrl+S)' }).on('click', () => downloadText('talking-head-config.json', store.exportJson()));
  io.addButton({ title: 'Import JSON' }).on('click', async () => {
    const text = await pickFile('application/json');
    if (text) {
      store.importJson(text);
      pane.refresh();
      hooks.onAgentChanged();
    }
  });
  io.addButton({ title: 'Reset all to defaults' }).on('click', () => {
    store.reset();
    pane.refresh();
    hooks.onAgentChanged();
  });
  io.addButton({ title: 'Fullscreen (F)' }).on('click', hooks.onFullscreen);

  // Keep the panel in sync when values change elsewhere (drag handles, keys, import, undo).
  store.onChange(() => pane.refresh());
  return pane;
}
