/**
 * Registered tokens + AMM setup state (public addresses/metadata only —
 * nothing here is secret). The AMM setup is a resumable step machine: each
 * completed step persists immediately so a crash/restart resumes mid-flow.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface TokenEntry {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  deployTxHash?: string;
}

/**
 * AMM setup steps. Transitions are gated on receipt SUCCESS of the previous
 * step's tx (a submitted-but-unconfirmed or reverted tx must not advance the
 * persisted state):
 *   deploying  — LP token + AMM deploys submitted (txAmm/txLp pending)
 *   set-minter — deploys confirmed; set_minter submitted or to be submitted
 *   ready      — set_minter confirmed; add_liquidity available
 */
export type AmmStep = 'deploying' | 'set-minter' | 'ready';

export interface AmmState {
  step: AmmStep;
  token0: string;
  token1: string;
  liquidityToken: string;
  amm: string;
  txAmm?: string;
  txLp?: string;
  txSetMinter?: string;
}

interface TokenStoreData {
  version: 1;
  tokens: TokenEntry[];
  amm?: AmmState;
}

const STORE_KEY = 'wallet/tokens.v1';

export class TokenStore {
  private data: TokenStoreData = {version: 1, tokens: []};
  private listeners = new Set<(d: TokenStoreData) => void>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      this.data = JSON.parse(raw) as TokenStoreData;
    }
    this.loaded = true;
    this.notify();
  }

  tokens(): TokenEntry[] {
    return [...this.data.tokens];
  }

  amm(): AmmState | undefined {
    return this.data.amm ? {...this.data.amm} : undefined;
  }

  subscribe(fn: (d: TokenStoreData) => void): () => void {
    this.listeners.add(fn);
    fn(this.data);
    return () => this.listeners.delete(fn);
  }

  async addToken(t: TokenEntry): Promise<void> {
    if (!this.data.tokens.find(x => x.address === t.address)) {
      this.data.tokens.push(t);
      await this.persist();
    }
  }

  async setAmm(state: AmmState | undefined): Promise<void> {
    this.data.amm = state;
    await this.persist();
  }

  async reset(): Promise<void> {
    this.data = {version: 1, tokens: []};
    await this.persist();
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(this.data));
    this.notify();
  }

  private notify() {
    for (const fn of this.listeners) {
      try {
        fn(this.data);
      } catch {}
    }
  }
}
