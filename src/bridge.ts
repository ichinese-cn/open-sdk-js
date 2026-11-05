/**
 * The container bridge's transport (protocol 1, docs/api/open-bridge.md), shared by the desktop app and
 * the mobile apps:
 *
 *   page → container   window.ichOpenBridge.postMessage(JSON.stringify({ v: 1, id, method, params }))
 *   container → page   window.__ichOpenBridgeReceive(JSON.stringify({ v: 1, id, ok, result | error }))
 *                      window.__ichOpenBridgeReceive(JSON.stringify({ v: 1, event, data }))
 *
 * The container checks the page's origin itself on every call (it never trusts what the page says).
 */
import { BRIDGE_PROTOCOL } from './gen/meta.ts';

export interface BridgeHost {
  postMessage(message: string): void;
}

export interface BridgeErrorInfo {
  code: string;
  message?: string;
}

/** An error from the container (or the fallback): `code` is one of the protocol's error codes. */
export class BridgeError extends Error {
  override readonly name = 'BridgeError';
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

type Pending = { resolve(v: unknown): void; reject(e: BridgeError): void; timer: ReturnType<typeof setTimeout> | null };

declare global {
  interface Window {
    ichOpenBridge?: BridgeHost;
    __ichOpenBridgeReceive?: (message: string) => void;
  }
}

const w = () => (typeof window === 'undefined' ? undefined : window);

/** The container's bridge object, when the page is inside one. */
export function host(): BridgeHost | undefined {
  const b = w()?.ichOpenBridge;
  return b && typeof b.postMessage === 'function' ? b : undefined;
}

export class Transport {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(private readonly bridge: BridgeHost) {
    const win = w();
    if (!win) return;
    const previous = win.__ichOpenBridgeReceive;
    win.__ichOpenBridgeReceive = (message: string) => {
      this.receive(message);
      // Another copy of the SDK on the same page (an old script tag) keeps working.
      if (previous && previous !== win.__ichOpenBridgeReceive) previous(message);
    };
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs: number | null = 15_000): Promise<T> {
    const id = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new BridgeError('timeout', `${method}: no answer from the container`));
            }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.bridge.postMessage(JSON.stringify({ v: BRIDGE_PROTOCOL, id, method, params }));
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('internal', (e as Error).message));
      }
    });
  }

  on(event: string, listener: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private receive(message: string) {
    let m: {
      v?: number;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: BridgeErrorInfo;
      event?: string;
      data?: unknown;
    };
    try {
      m = typeof message === 'string' ? JSON.parse(message) : (message as typeof m);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (typeof m.event === 'string') {
      for (const l of this.listeners.get(m.event) ?? []) {
        try {
          l(m.data);
        } catch {
          // a listener's own failure
        }
      }
      return;
    }
    const p = m.id ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id!);
    if (p.timer) clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result ?? {});
    else p.reject(new BridgeError(m.error?.code ?? 'internal', m.error?.message));
  }
}
