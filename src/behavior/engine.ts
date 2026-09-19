import type { AgentState } from '../agent/types';
import type { Config } from '../config/schema';
import { MouthFollower } from './mouth';
import { clamp, clamp01, easeInOut, easeOut, lerp, rand, smoothK } from '../util/math';
import type { AgentAudioLevel } from '../agent/types';

/** Everything the renderer needs for one frame. All values are already smoothed. */
export interface FaceParams {
  eyeOpenL: number;
  eyeOpenR: number;
  /** Pupil offset in units of eye radius, -1..1. */
  pupilX: number;
  pupilY: number;
  pupilScale: number;
  /** Brow height offset in px (positive = raised) and tilt (positive = inner ends down / furrow). */
  browL: number;
  browR: number;
  browFurrow: number;
  mouthOpen: number;
  mouthWidth: number;
  /** Mouth corner lift, -1..1 (smile). */
  mouthSmile: number;
  glow: number;
  brightness: number;
  shimmer: number;
}

interface Target {
  pupilX: number;
  pupilY: number;
  pupilScale: number;
  browL: number;
  browR: number;
  browFurrow: number;
  mouthSmile: number;
  glowMul: number;
  brightness: number;
  shimmer: number;
  lidBase: number;
}

export interface BehaviorInput {
  state: AgentState;
  level: AgentAudioLevel;
  /** Optional external gaze target in -1..1 (from a webcam tracker); null when nobody is seen. */
  gaze: { x: number; y: number } | null;
  msSinceActivity: number;
}

const STATE_EASE_MS = 300;

export class BehaviorEngine {
  private p: FaceParams = {
    eyeOpenL: 1,
    eyeOpenR: 1,
    pupilX: 0,
    pupilY: 0,
    pupilScale: 1,
    browL: 0,
    browR: 0,
    browFurrow: 0,
    mouthOpen: 0,
    mouthWidth: 1,
    mouthSmile: 0,
    glow: 1,
    brightness: 1,
    shimmer: 0,
  };
  private mouth = new MouthFollower();
  private lastState: AgentState = 'idle';

  // Blink state machine
  private nextBlinkAt = 0;
  private blinkStart = -1;
  private blinkPending = false; // double blink queued
  private readonly blinkCloseMs = 60;
  private readonly blinkOpenMs = 110;

  // Saccades
  private saccadeFrom = { x: 0, y: 0 };
  private saccadeTo = { x: 0, y: 0 };
  private saccadeStart = 0;
  private nextSaccadeAt = 0;
  private driftPhase = Math.random() * 100;

  // Glance-away while speaking / attract look-around
  private glanceUntil = 0;

  private t = 0;

  update(input: BehaviorInput, cfg: Config, dtMs: number): FaceParams {
    this.t += dtMs;
    const t = this.t;
    const state = input.state;
    const b = cfg.behavior;

    if (state !== this.lastState) {
      this.triggerBlink(t);
      this.lastState = state;
      // New target quickly when the state changes (e.g. look up when thinking).
      this.nextSaccadeAt = t;
    }

    const attract = state === 'idle' && input.msSinceActivity > b.attractAfterSec * 1000;
    const target = this.stateTarget(state, t, attract);

    // --- Eyes: saccades + drift + optional gaze target
    this.updateSaccades(state, input.gaze, attract, t);
    const sacT = easeOut((t - this.saccadeStart) / 50);
    let px = lerp(this.saccadeFrom.x, this.saccadeTo.x, sacT);
    let py = lerp(this.saccadeFrom.y, this.saccadeTo.y, sacT);
    // Slow drift on top of the held target, smaller when attending to a visitor.
    const driftAmp = state === 'idle' ? 0.08 : 0.03;
    px += driftAmp * Math.sin(t * 0.0007 + this.driftPhase);
    py += driftAmp * 0.6 * Math.sin(t * 0.0011 + this.driftPhase * 1.3);
    if (state === 'thinking') {
      // Held target from stateTarget wins for the "look up and away" pose.
      px = lerp(px, target.pupilX, 0.8);
      py = lerp(py, target.pupilY, 0.8);
    }
    const kPupil = smoothK(80, dtMs);
    this.p.pupilX += (clamp(px, -1, 1) - this.p.pupilX) * kPupil;
    this.p.pupilY += (clamp(py, -1, 1) - this.p.pupilY) * kPupil;

    // --- Blinks
    if (this.blinkStart < 0 && t >= this.nextBlinkAt) this.triggerBlink(t);
    const blink = this.blinkAmount(t, b);
    const lid = target.lidBase * (1 - blink);
    // Eyes are the one thing that must be snappy; a blink does not ease.
    const kLid = smoothK(blink > 0 ? 0 : 200, dtMs);
    this.p.eyeOpenL += (lid - this.p.eyeOpenL) * kLid;
    this.p.eyeOpenR += (lid - this.p.eyeOpenR) * kLid;

    // --- Mouth
    const m = this.mouth.update(input.level, cfg.mouth, dtMs);
    const breathing = state === 'idle' || state === 'listening' ? 0.015 * (0.5 + 0.5 * Math.sin(t * 0.0012)) : 0;
    const mouthOpen = state === 'speaking' ? m.open : breathing;
    this.p.mouthOpen += (mouthOpen - this.p.mouthOpen) * smoothK(state === 'speaking' ? 0 : 200, dtMs);
    this.p.mouthWidth += ((state === 'speaking' ? m.width : 1) - this.p.mouthWidth) * smoothK(120, dtMs);

    // --- Everything else eases over ~300 ms
    const k = smoothK(STATE_EASE_MS, dtMs);
    const peakLift = state === 'speaking' ? 10 * clamp01((m.open - 0.6) / 0.4) : 0;
    this.p.browL += (target.browL + peakLift - this.p.browL) * k;
    this.p.browR += (target.browR + peakLift - this.p.browR) * k;
    this.p.browFurrow += (target.browFurrow - this.p.browFurrow) * k;
    this.p.pupilScale += (target.pupilScale - this.p.pupilScale) * k;
    this.p.mouthSmile += (target.mouthSmile - this.p.mouthSmile) * k;
    this.p.shimmer += (target.shimmer - this.p.shimmer) * k;
    this.p.brightness += (target.brightness - this.p.brightness) * k;

    // Glow breathes on a ~4 s cycle in idle, steadier otherwise.
    const breath = 0.5 + 0.5 * Math.sin((t / 4000) * Math.PI * 2);
    const glowBreath = state === 'idle' ? lerp(0.85, 1.15, breath) : 1;
    this.p.glow += (target.glowMul * glowBreath - this.p.glow) * k;

    return this.p;
  }

  private stateTarget(state: AgentState, t: number, attract: boolean): Target {
    const base: Target = {
      pupilX: 0,
      pupilY: 0,
      pupilScale: 1,
      browL: 0,
      browR: 0,
      browFurrow: 0,
      mouthSmile: 0.15,
      glowMul: 1,
      brightness: 1,
      shimmer: 0,
      lidBase: 1,
    };
    switch (state) {
      case 'listening':
        return { ...base, pupilScale: 1.1, browL: 8, browR: 8, glowMul: 1.15, mouthSmile: 0.25 };
      case 'thinking': {
        const side = Math.sin(this.driftPhase) > 0 ? 1 : -1;
        return { ...base, pupilX: 0.55 * side, pupilY: -0.55, browFurrow: 1, browL: -3, browR: 6, shimmer: 1, mouthSmile: 0 };
      }
      case 'connecting':
        return { ...base, shimmer: 0.6, pupilY: -0.2, mouthSmile: 0 };
      case 'speaking':
        return { ...base, glowMul: 1.1, mouthSmile: 0.1 };
      case 'disconnected':
        return { ...base, lidBase: 0.55, browL: -8, browR: -8, brightness: 0.4, glowMul: 0.6, mouthSmile: -0.1 };
      case 'idle':
      default:
        if (attract) {
          const pulse = 0.5 + 0.5 * Math.sin(t / 2500);
          return { ...base, glowMul: 1.15 + 0.2 * pulse, mouthSmile: 0.3 };
        }
        return base;
    }
  }

  private updateSaccades(state: AgentState, gaze: BehaviorInput['gaze'], attract: boolean, t: number): void {
    if (gaze) {
      // Follow the tracker; ease each frame via the pupil smoothing.
      this.saccadeFrom = this.saccadeTo = { x: gaze.x, y: gaze.y };
      this.saccadeStart = t - 1000;
      return;
    }
    if (t < this.nextSaccadeAt) return;
    this.saccadeFrom = { ...this.saccadeTo };
    this.saccadeStart = t;
    let radius = 0.3;
    let hold: number;
    if (state === 'listening' || state === 'speaking') {
      // Mostly on the visitor (center), with an occasional glance away while speaking.
      const glance = state === 'speaking' && Math.random() < 0.18;
      radius = glance ? 0.35 : 0.08;
      hold = glance ? rand(400, 900) : rand(1200, 3000);
      if (glance) this.glanceUntil = t + hold;
    } else if (attract) {
      radius = 0.6;
      hold = rand(1500, 4000);
    } else {
      hold = rand(1000, 3000);
    }
    this.saccadeTo = { x: rand(-radius, radius), y: rand(-radius * 0.7, radius * 0.7) };
    this.nextSaccadeAt = t + hold;
  }

  private triggerBlink(t: number): void {
    if (this.blinkStart >= 0) return;
    this.blinkStart = t;
  }

  private blinkAmount(t: number, b: Config['behavior']): number {
    if (this.blinkStart < 0) return 0;
    const dt = t - this.blinkStart;
    const total = this.blinkCloseMs + this.blinkOpenMs;
    if (dt >= total) {
      this.blinkStart = -1;
      if (this.blinkPending) {
        this.blinkPending = false;
        this.blinkStart = t;
        return 0;
      }
      if (Math.random() < b.doubleBlinkChance) {
        this.blinkPending = true;
        this.nextBlinkAt = t + 120;
      } else {
        this.nextBlinkAt = t + rand(b.blinkMinSec * 1000, b.blinkMaxSec * 1000);
      }
      return 0;
    }
    if (dt < this.blinkCloseMs) return easeInOut(dt / this.blinkCloseMs);
    return 1 - easeInOut((dt - this.blinkCloseMs) / this.blinkOpenMs);
  }

  /** Exposed for the HUD. */
  isGlancing(t: number): boolean {
    return t < this.glanceUntil;
  }
}
