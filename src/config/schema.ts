export type Provider = 'elevenlabs' | 'micloop' | 'echo';
export type TurnMode = 'pushToTalk' | 'openMic';

export interface Config {
  version: number;
  agent: {
    provider: Provider;
    agentId: string;
    turnMode: TurnMode;
    /** End the provider session after this much silence from both sides. */
    sessionIdleTimeoutSec: number;
    /** Connect as soon as the Start overlay is dismissed (else on first talk press). */
    connectOnStart: boolean;
  };
  face: {
    color: string;
    lineWidth: number;
    glow: number;
    brightness: number;
    layout: {
      eyeSpacing: number;
      eyeY: number;
      eyeSize: number;
      browOffset: number;
      mouthY: number;
      mouthWidth: number;
    };
    showNose: boolean;
    showContour: boolean;
    /** Per-feature visibility, for surfaces (a painting) that already carry some features. */
    show: { eyeOutline: boolean; pupils: boolean; brows: boolean; mouth: boolean };
    /** Soft light wash so the projector "lights" the surface; breathes and brightens on speech. */
    wash: {
      enabled: boolean;
      color: string;
      opacity: number;
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      softness: number;
      breathe: number;
      speechBoost: number;
    };
  };
  mouth: {
    gate: number;
    attackMs: number;
    releaseMs: number;
    gamma: number;
    /** Multiplier on the raw provider level before the gate. */
    gain: number;
    jitter: number;
  };
  behavior: {
    blinkMinSec: number;
    blinkMaxSec: number;
    doubleBlinkChance: number;
    attractAfterSec: number;
  };
  mapping: {
    transform: {
      x: number;
      y: number;
      scale: number;
      scaleX: number;
      scaleY: number;
      rotation: number;
      flipH: boolean;
      flipV: boolean;
    };
    /** Four corners (TL, TR, BR, BL) in normalized output space. */
    cornerPin: [number, number][];
    ellipseMask: { enabled: boolean; cx: number; cy: number; rx: number; ry: number; feather: number };
    output: {
      brightness: number;
      hotspot: { enabled: boolean; cx: number; cy: number; radius: number; strength: number };
    };
  };
  gaze: { enabled: boolean; invertX: boolean; gainX: number; gainY: number };
  /** Edit-mode reference photo of the surface, drawn behind the face (image data is stored separately). */
  underlay: { visible: boolean; opacity: number; scale: number; x: number; y: number };
}

export const CONFIG_VERSION = 1;

export const defaultConfig = (): Config => ({
  version: CONFIG_VERSION,
  agent: {
    provider: 'micloop',
    agentId: '',
    turnMode: 'pushToTalk',
    sessionIdleTimeoutSec: 45,
    connectOnStart: false,
  },
  face: {
    color: '#bff6ff',
    lineWidth: 4,
    glow: 20,
    brightness: 1.0,
    layout: { eyeSpacing: 220, eyeY: -80, eyeSize: 70, browOffset: 60, mouthY: 170, mouthWidth: 200 },
    showNose: false,
    showContour: false,
    show: { eyeOutline: true, pupils: true, brows: true, mouth: true },
    wash: { enabled: false, color: '#ffd9a8', opacity: 0.35, cx: 0, cy: 20, rx: 330, ry: 400, softness: 0.5, breathe: 0.15, speechBoost: 0.2 },
  },
  mouth: { gate: 0.05, attackMs: 40, releaseMs: 120, gamma: 0.7, gain: 2.5, jitter: 0.05 },
  behavior: { blinkMinSec: 2, blinkMaxSec: 6, doubleBlinkChance: 0.15, attractAfterSec: 60 },
  mapping: {
    transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false },
    cornerPin: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    ellipseMask: { enabled: false, cx: 0.5, cy: 0.5, rx: 0.45, ry: 0.5, feather: 0.05 },
    output: { brightness: 1, hotspot: { enabled: false, cx: 0.5, cy: 0.5, radius: 0.4, strength: 0.3 } },
  },
  gaze: { enabled: false, invertX: true, gainX: 1, gainY: 0.6 },
  underlay: { visible: true, opacity: 0.5, scale: 1, x: 0, y: 0 },
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `src` over `base`, keeping only keys that exist in `base` (unknown keys are dropped). */
export function mergeInto<T>(base: T, src: unknown): T {
  if (!isObj(base) || !isObj(src)) return (src === undefined ? base : (src as T));
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(base)) {
    if (k in src) out[k] = mergeInto((base as Record<string, unknown>)[k], src[k]);
  }
  return out as T;
}

/** Load any older exported config into the current schema. Add per-version steps here as the schema evolves. */
export function migrate(raw: unknown): Config {
  const base = defaultConfig();
  if (!isObj(raw)) return base;
  const v = typeof raw.version === 'number' ? raw.version : 0;
  let data: Record<string, unknown> = { ...raw };
  // v0 -> v1: nothing to rewrite yet; unknown fields are dropped by mergeInto.
  if (v < 1) data = { ...data };
  const cfg = mergeInto(base, data);
  cfg.version = CONFIG_VERSION;
  if (!Array.isArray(cfg.mapping.cornerPin) || cfg.mapping.cornerPin.length !== 4) {
    cfg.mapping.cornerPin = base.mapping.cornerPin;
  }
  return cfg;
}

export const cloneConfig = (c: Config): Config => JSON.parse(JSON.stringify(c)) as Config;

/**
 * Copy `src` into `target` in place, preserving nested object identity so UI bindings
 * (tweakpane) keep pointing at live objects. Arrays are replaced element-wise.
 */
export function assignDeep<T>(target: T, src: T): T {
  if (Array.isArray(target) && Array.isArray(src)) {
    target.length = 0;
    for (const v of src) target.push(v);
    return target;
  }
  if (isObj(target) && isObj(src)) {
    for (const k of Object.keys(src)) {
      const tv = (target as Record<string, unknown>)[k];
      const sv = src[k];
      if ((isObj(tv) && isObj(sv)) || (Array.isArray(tv) && Array.isArray(sv))) assignDeep(tv, sv);
      else (target as Record<string, unknown>)[k] = sv;
    }
    return target;
  }
  return src;
}
