/**
 * Typed RPC client over the WebView-hosted PXE (see wallet/pxe-web).
 *
 * Owns: request/response correlation with per-call timeouts, progress + log
 * event fan-out, the native prove bridge (proveRequest -> Prover.chonkProve ->
 * proveResult, the proven rn-spike path), and crash handling (reject all
 * in-flight calls so callers can surface a recoverable error).
 */
import type WebView from 'react-native-webview';
import type {WebViewMessageEvent} from 'react-native-webview';
import {RPC_TIMEOUT_MS} from '../config';
import {MemoryInfo, Prover} from '../native/modules';

/** Structured progress stage (from the WebView flow's `stage()` emit). */
export interface ProgressStage {
  label: string;
  index: number;
  total: number;
}

/** Raised when a flow is cancelled via {@link PxeSession.abort}. */
export class AbortError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export interface ProveMetrics {
  verified: boolean;
  proveMs: number;
  peakRssMb: number;
  proofFields: number;
  wallMs: number;
  appPeakRssMb?: number;
}

export type SessionEvent =
  | {kind: 'ready'}
  | {kind: 'log'; message: string}
  | {
      kind: 'progress';
      id: number;
      phase: string;
      data?: Record<string, unknown>;
      stage?: ProgressStage;
    }
  | {kind: 'prove-metrics'; metrics: ProveMetrics}
  | {kind: 'crashed'; reason: string};

interface PendingCall {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PROVE_PAYLOAD_B64 = 64 * 1024 * 1024;

export class PxeSession {
  private seq = 0;
  private pending = new Map<number, PendingCall>();
  private webView: WebView | null = null;
  private listeners = new Set<(e: SessionEvent) => void>();
  private crashed = false;
  ready = false;

  attach(webView: WebView | null) {
    this.webView = webView;
  }

  subscribe(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }

  /**
   * Call an RPC method in the WebView. Rejects on timeout/crash/error, or with
   * {@link AbortError} if the call is cancelled via {@link abort}.
   *
   * `onId` receives the call id synchronously before the request is posted, so
   * a caller (e.g. a flow) can record the id to cancel later.
   */
  call<T>(
    method: string,
    params: object = {},
    timeoutMs: number = RPC_TIMEOUT_MS,
    onId?: (id: number) => void,
    cancellable = false,
  ): Promise<T> {
    if (this.crashed) {
      return Promise.reject(new Error('PXE session crashed; restart required'));
    }
    const id = ++this.seq;
    onId?.(id);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      // `cancellable` tells the WebView to arm abort wiring for this call only;
      // background calls (poller/refresh) leave it false so they never disturb
      // the in-flight flow's abort signal.
      this.post({type: 'rpc', id, method, params, cancellable});
    });
  }

  /**
   * Cancel an in-flight call by id. Posts an abort to the WebView (cancels the
   * JS-phase work — sync, simulate, authwit generation — at the next boundary)
   * AND asks the native prover to stop (best-effort; lands at the next circuit
   * boundary, the final prove step still completes). The call's promise rejects
   * with {@link AbortError} once the WebView reports the cancelled result.
   */
  abort(id: number) {
    if (this.crashed || !this.webView) {
      return;
    }
    this.post({type: 'abort', id});
    // The native prove runs outside the WebView; ask it to stop too.
    Prover.requestAbort?.().catch(() => {});
  }

  /** Wire this to the WebView's onMessage. */
  handleMessage = async (e: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        // A 'ready' with calls in flight means the document reloaded under
        // us — those calls belong to a dead page and will never resolve.
        if (this.pending.size > 0) {
          for (const [, call] of this.pending) {
            clearTimeout(call.timer);
            call.reject(new Error('WebView reloaded; PXE session reset'));
          }
          this.pending.clear();
        }
        this.ready = true;
        this.emit({kind: 'ready'});
        break;
      case 'log':
        if (typeof msg.msg === 'string') {
          this.emit({kind: 'log', message: msg.msg});
        }
        break;
      case 'progress':
        if (typeof msg.id === 'number' && typeof msg.phase === 'string') {
          const stage = parseStage(msg.data);
          this.emit({kind: 'progress', id: msg.id, phase: msg.phase, data: msg.data, stage});
        }
        break;
      case 'rpcResult': {
        if (typeof msg.id !== 'number') {
          return;
        }
        const call = this.pending.get(msg.id);
        if (!call) {
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.ok === true) {
          call.resolve(msg.result);
        } else if (msg.aborted === true) {
          call.reject(new AbortError());
        } else {
          call.reject(new Error(typeof msg.error === 'string' ? msg.error : `${call.method} failed`));
        }
        break;
      }
      case 'proveRequest':
        await this.handleProveRequest(msg);
        break;
      default:
        break;
    }
  };

  /** Reject everything in flight; callers restart the session/WebView. */
  handleCrash(reason: string) {
    this.crashed = true;
    this.ready = false;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(`PXE session crashed: ${reason}`));
    }
    this.pending.clear();
    this.emit({kind: 'crashed', reason});
  }

  /** Fresh session state after a WebView reload (same instance is reused). */
  resetAfterReload() {
    this.crashed = false;
    this.ready = false;
  }

  private async handleProveRequest(msg: any) {
    // Bridge guard: the WebView content is our own bundle, but validate shape
    // and size before handing bytes to native (same policy as the spike).
    if (typeof msg.id !== 'number' || typeof msg.ivcInputsB64 !== 'string') {
      this.emit({kind: 'log', message: 'proveRequest: bad payload, ignored'});
      return;
    }
    if (msg.ivcInputsB64.length > MAX_PROVE_PAYLOAD_B64) {
      this.post({type: 'proveResult', id: msg.id, verified: false, proofFields: [], vkHex: ''});
      this.emit({kind: 'log', message: 'proveRequest: payload too large, rejected'});
      return;
    }
    const t0 = Date.now();
    try {
      const resJson = await Prover.chonkProve(msg.ivcInputsB64);
      const r = JSON.parse(resJson);
      let appPeakRssMb: number | undefined;
      try {
        appPeakRssMb = JSON.parse(await MemoryInfo.sample()).peakRssMb;
      } catch {}
      this.emit({
        kind: 'prove-metrics',
        metrics: {
          verified: !!r.verified,
          proveMs: r.prove_ms,
          peakRssMb: r.peak_rss_mb,
          proofFields: r.proof_fields?.length ?? 0,
          wallMs: Date.now() - t0,
          appPeakRssMb,
        },
      });
      this.post({
        type: 'proveResult',
        id: msg.id,
        verified: r.verified,
        proofFields: (r.proof_fields as string[]).map(h => (h.startsWith('0x') ? h : '0x' + h)),
        vkHex: r.vk,
        proveMs: r.prove_ms,
        peakRssMb: r.peak_rss_mb,
      });
    } catch (err: any) {
      this.emit({kind: 'log', message: `native prove FAILED: ${err?.message ?? err}`});
      this.post({type: 'proveResult', id: msg.id, verified: false, proofFields: [], vkHex: ''});
    }
  }

  private post(msg: object) {
    const wv = this.webView;
    if (!wv) {
      throw new Error('PxeSession: WebView not attached');
    }
    wv.injectJavaScript(`window.__aztecOnHostMessage(${JSON.stringify(msg)}); true;`);
  }
}

/** Extract a well-formed {label,index,total} stage from a progress data blob. */
function parseStage(data: unknown): ProgressStage | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const d = data as Record<string, unknown>;
  if (typeof d.label === 'string' && typeof d.index === 'number' && typeof d.total === 'number') {
    return {label: d.label, index: d.index, total: d.total};
  }
  return undefined;
}
