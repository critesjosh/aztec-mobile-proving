/**
 * Persisted transaction tracker (public data only: hashes, kinds, statuses).
 *
 * Lifecycle: a tx is only recorded here once it is `submitted` (txHash
 * exists). Failures before submission are surfaced by the flow that ran them
 * and never enter this store — "submitted but response lost" cannot be
 * distinguished from "never submitted", so unsubmitted work is rebuilt
 * intentionally by the user (see wallet/PLAN.md).
 *
 * Status mapping follows the v5 TxStatus union: `pending` keeps polling;
 * mined statuses (proposed/checkpointed/proven/finalized) settle; `dropped`
 * settles only after a grace window.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {DROPPED_GRACE_MS, PENDING_MAX_AGE_MS} from '../config';

export type TxKind =
  | 'account-deploy'
  | 'token-deploy'
  | 'mint'
  | 'transfer'
  | 'amm-deploy'
  | 'amm-set-minter'
  | 'amm-add-liquidity';

export type TxSettledStatus = 'proposed' | 'checkpointed' | 'proven' | 'finalized' | 'dropped';
export type TxTrackedStatus = 'submitted' | 'pending' | TxSettledStatus;

export interface TrackedTx {
  txHash: string;
  kind: TxKind;
  label: string;
  createdAt: number;
  status: TxTrackedStatus;
  /** v5 TxExecutionResult for mined txs: 'success' | 'reverted'. */
  executionResult?: string;
  /** Node-reported drop reason, if any. */
  error?: string;
  blockNumber?: number;
  lastCheckedAt?: number;
  meta?: Record<string, string>;
}

const STORE_KEY = 'wallet/txs.v1';
const MINED = new Set(['proposed', 'checkpointed', 'proven', 'finalized']);

export function isMined(tx: TrackedTx): boolean {
  return MINED.has(tx.status);
}

/** Mined AND executed successfully (a reverted tx is on-chain but failed). */
export function isSucceeded(tx: TrackedTx): boolean {
  return isMined(tx) && tx.executionResult !== 'reverted';
}

export function isSettled(tx: TrackedTx): boolean {
  return isMined(tx) || tx.status === 'dropped';
}

export class PendingTxStore {
  private txs: TrackedTx[] = [];
  private listeners = new Set<(txs: TrackedTx[]) => void>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await AsyncStorage.getItem(STORE_KEY);
    this.txs = raw ? (JSON.parse(raw) as TrackedTx[]) : [];
    this.loaded = true;
    this.notify();
  }

  list(): TrackedTx[] {
    return [...this.txs].sort((a, b) => b.createdAt - a.createdAt);
  }

  unsettled(): TrackedTx[] {
    return this.txs.filter(t => !isSettled(t));
  }

  subscribe(fn: (txs: TrackedTx[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  async add(tx: Omit<TrackedTx, 'createdAt' | 'status'>): Promise<void> {
    this.txs.push({...tx, createdAt: Date.now(), status: 'submitted'});
    await this.persist();
  }

  /**
   * Apply a polled receipt status. Handles the DROPPED grace window: a fresh
   * tx reporting dropped is kept pending until the grace elapses; an old
   * pending tx past PENDING_MAX_AGE_MS reporting dropped settles immediately.
   */
  async applyReceipt(receipt: {
    txHash: string;
    status: string;
    blockNumber?: number;
    executionResult?: string;
    error?: string;
  }): Promise<void> {
    const tx = this.txs.find(t => t.txHash === receipt.txHash);
    if (!tx || isSettled(tx)) {
      return;
    }
    tx.lastCheckedAt = Date.now();
    const age = Date.now() - tx.createdAt;
    if (MINED.has(receipt.status)) {
      tx.status = receipt.status as TxSettledStatus;
      tx.blockNumber = receipt.blockNumber;
      tx.executionResult = receipt.executionResult;
    } else if (receipt.status === 'dropped') {
      if (age > DROPPED_GRACE_MS || age > PENDING_MAX_AGE_MS) {
        tx.status = 'dropped';
        tx.error = receipt.error;
      }
      // else: keep current status; poller retries.
    } else if (receipt.status === 'pending') {
      tx.status = 'pending';
    }
    await this.persist();
  }

  async clearSettled(): Promise<void> {
    this.txs = this.txs.filter(t => !isSettled(t));
    await this.persist();
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(this.txs));
    this.notify();
  }

  private notify() {
    const snapshot = this.list();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {}
    }
  }
}
