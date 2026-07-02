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
  | {kind: 'progress'; id: number; phase: string; data?: Record<string, unknown>}
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

  /** Call an RPC method in the WebView. Rejects on timeout/crash/error. */
  call<T>(method: string, params: object = {}, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    if (this.crashed) {
      return Promise.reject(new Error('PXE session crashed; restart required'));
    }
    const id = ++this.seq;
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
      this.post({type: 'rpc', id, method, params});
    });
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
          this.emit({kind: 'progress', id: msg.id, phase: msg.phase, data: msg.data});
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
