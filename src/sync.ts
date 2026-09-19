import type { Config } from './config/schema';

/**
 * Messages between the face window (on the projector) and a control tab (?control) in the same
 * browser. BroadcastChannel is same-origin and same-browser, so no server is needed.
 */
export type SyncMessage =
  | { type: 'hello'; role: Role }
  | { type: 'config'; cfg: Config }
  | { type: 'ui'; editMode?: boolean; testPattern?: boolean; stage?: number; selected?: number }
  | { type: 'talk'; on: boolean }
  | { type: 'underlay' }
  | { type: 'status'; hud: string }
  | { type: 'log'; kind: 'info' | 'err' | 'agent' | 'user'; text: string };

export type Role = 'face' | 'control';

export class Sync {
  private ch: BroadcastChannel | null = null;
  private cbs: ((m: SyncMessage) => void)[] = [];
  /** True once the other side has said hello or sent anything. */
  peerSeen = false;

  constructor(readonly role: Role) {
    if ('BroadcastChannel' in window) {
      this.ch = new BroadcastChannel('talking-head');
      this.ch.onmessage = (e: MessageEvent<SyncMessage>) => {
        this.peerSeen = true;
        for (const cb of this.cbs) cb(e.data);
      };
      this.send({ type: 'hello', role });
    }
  }

  get available(): boolean {
    return this.ch !== null;
  }

  send(m: SyncMessage): void {
    this.ch?.postMessage(m);
  }

  on(cb: (m: SyncMessage) => void): void {
    this.cbs.push(cb);
  }
}
