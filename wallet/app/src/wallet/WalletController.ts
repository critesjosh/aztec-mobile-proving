/**
 * Wallet orchestration: bootstrap (loopback server -> WebView -> SRS -> PXE
 * boot -> vault restore), user flows (account/token/transfer/AMM), receipt
 * polling, and crash recovery. UI subscribes to an immutable snapshot.
 */
import {
  BOOT_TIMEOUT_MS,
  FLOW_TIMEOUT_MS,
  NODE_URL,
  POLL_INTERVAL_MS,
  SPONSORED_FPC,
} from '../config';
import {MemoryInfo, Prover, PxeServer} from '../native/modules';
import {
  generateAccountMaterial,
  getOrCreateStoreKey,
  loadVault,
  saveVault,
  type Vault,
} from '../keys/keyStore';
import {
  isAbortError,
  PxeSession,
  type ProgressStage,
  type ProveMetrics,
  type SessionEvent,
} from '../pxe/PxeSession';
import {TokenStore, type AmmState, type TokenEntry} from '../tokens/tokenStore';
import {isSucceeded, PendingTxStore, type TrackedTx, type TxKind} from '../txs/pendingTxStore';

export type WalletPhase =
  | 'init' // starting loopback server
  | 'webview' // waiting for WebView ready
  | 'boot' // SRS + PXE boot + vault restore
  | 'onboarding' // no account yet
  | 'ready'
  | 'crashed' // WebView render process died; restartable
  | 'fatal'; // unrecoverable (e.g. port bind failure)

export interface MemorySample {
  totalPssMb?: number;
  vmRssMb?: number;
  peakRssMb?: number;
  nativeHeapMb?: number;
}

export interface WalletSnapshot {
  phase: WalletPhase;
  fatalError?: string;
  origin?: string;
  nodeInfo?: {l1ChainId: number; rollupVersion: number; nodeVersion: string; storeEncrypted?: boolean};
  storageProbe?: unknown;
  srsStatus?: string;
  account?: {alias: string; address: string; deployed: boolean; deployTxHash?: string};
  balances: Record<string, string>;
  tokens: TokenEntry[];
  amm?: AmmState;
  txs: TrackedTx[];
  logs: string[];
  memory?: MemorySample;
  proveMetrics: ProveMetrics[];
  /** Label of the flow currently running, or null. */
  busy: string | null;
  /** Structured stage of the running flow (e.g. "Proving on device 3/3"). */
  busyStage?: ProgressStage;
  /** True while a flow is running and cancellable (has an in-flight call). */
  cancellable: boolean;
  /** Last flow error, surfaced in UI until the next flow. */
  flowError?: string;
  /** Block the PXE has synced private state up to (status display). */
  syncedBlock?: number;
}

type Listener = (s: WalletSnapshot) => void;

export class WalletController {
  readonly session = new PxeSession();
  readonly txStore = new PendingTxStore();
  readonly tokenStore = new TokenStore();

  private vault: Vault | null = null;
  private snapshot: WalletSnapshot = {
    phase: 'init',
    balances: {},
    tokens: [],
    txs: [],
    logs: [],
    proveMetrics: [],
    busy: null,
    cancellable: false,
  };
  private listeners = new Set<Listener>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private booted = false;
  /** Id of the in-flight flow call, for cancellation. */
  private activeCallId: number | null = null;

  constructor() {
    this.session.subscribe(this.onSessionEvent);
    this.txStore.subscribe(txs => this.update({txs}));
    this.tokenStore.subscribe(d => this.update({tokens: d.tokens, amm: d.amm}));
  }

  getSnapshot(): WalletSnapshot {
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<WalletSnapshot>) {
    this.snapshot = {...this.snapshot, ...patch};
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {}
    }
  }

  private log(message: string) {
    const logs = [...this.snapshot.logs.slice(-499), message];
    this.update({logs});
    // eslint-disable-next-line no-console
    console.log('[wallet]', message);
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /** Phase 1: storage + loopback server. Called once on mount. */
  async start(): Promise<void> {
    try {
      await Promise.all([this.txStore.load(), this.tokenStore.load()]);
      const origin = await PxeServer.start();
      this.log(`asset server at ${origin}`);
      this.update({origin, phase: 'webview'});
    } catch (e: any) {
      this.update({phase: 'fatal', fatalError: `asset server failed: ${e?.message ?? e}`});
    }
  }

  /** Phase 2: driven by the WebView 'ready' event. */
  private async onWebViewReady(): Promise<void> {
    if (this.booted) {
      // The page reloaded outside the crash/restart path (e.g. the renderer
      // was silently replaced). The fresh document is unbooted; re-running
      // the boot sequence is the only way back to a working session.
      this.log('WebView reloaded unexpectedly — rebooting PXE session');
      this.update({phase: 'boot', busy: null});
    }
    this.booted = true;
    this.update({phase: 'boot'});
    try {
      const probe = await this.session.call('storageProbe', {}, 30_000);
      this.update({storageProbe: probe});
      this.log(`storage probe: ${JSON.stringify(probe)}`);

      this.log('initializing SRS in native prover…');
      const srs = await Prover.initSrs();
      this.update({srsStatus: srs});
      this.log(`SRS: ${srs}`);

      // Derive (or restore) the Keystore-sealed store key so the persistent PXE
      // store can be opened encrypted at rest. Best-effort: if the secure key
      // is unavailable, boot without it and the WebView falls back to the
      // persistent-IndexedDB + in-memory-walletDB store.
      let storeKey: string | undefined;
      try {
        storeKey = await getOrCreateStoreKey();
      } catch (e: any) {
        this.log(`store key unavailable (${firstLine(e?.message ?? String(e))}); booting without store encryption`);
      }

      this.log('booting PXE (encrypted store if available)…');
      const nodeInfo = await this.session.call<
        WalletSnapshot['nodeInfo'] & {storeEncrypted?: boolean}
      >(
        'boot',
        {
          nodeUrl: NODE_URL,
          sponsoredFpc: SPONSORED_FPC,
          persistent: true,
          encrypted: !!storeKey,
          storeKey,
        },
        BOOT_TIMEOUT_MS,
      );
      this.update({nodeInfo});
      this.log(
        `PXE ready: chain ${nodeInfo?.l1ChainId} rollup ${nodeInfo?.rollupVersion} ` +
          `(store ${nodeInfo?.storeEncrypted ? 'ENCRYPTED' : 'persistent-plain'})`,
      );

      this.vault = await loadVault();
      if (this.vault && this.vault.accounts.length > 0) {
        const acct = this.vault.accounts[0];
        this.log(`restoring account ${acct.alias}…`);
        const res = await this.session.call<{accounts: {address: string}[]}>(
          'restoreAccounts',
          {
            accounts: this.vault.accounts.map(a => ({
              secret: a.secret,
              salt: a.salt,
              signingKey: a.signingKey,
              alias: a.alias,
            })),
          },
          120_000,
        );
        const address = res.accounts[0]?.address;
        if (acct.address && address !== acct.address) {
          throw new Error(`restored address mismatch: ${address} != ${acct.address}`);
        }
        this.log(`account restored (deployed=${acct.deployed})`);
        this.setAccountState(acct.alias, address, acct.deployed, acct.deployTxHash);
        this.update({phase: 'ready'});
        this.startPoller();
        void this.refreshBalances();
      } else {
        this.update({phase: 'onboarding'});
      }
      void this.sampleMemory();
    } catch (e: any) {
      this.log(`bootstrap failed: ${e?.message ?? e}`);
      this.update({phase: 'fatal', fatalError: `bootstrap failed: ${e?.message ?? e}`});
    }
  }

  private setAccountState(alias: string, address: string, deployed: boolean, deployTxHash?: string) {
    this.update({account: {alias, address, deployed, deployTxHash}});
  }

  /** WebView render-process death or load failure: recoverable via reload. */
  onWebViewCrash(reason: string) {
    this.log(`PXE WebView stopped: ${reason}`);
    this.session.handleCrash(reason);
    this.stopPoller();
    this.update({phase: 'crashed', busy: null});
  }

  /** After the UI reloads the WebView following a crash. */
  async restartSession(): Promise<void> {
    this.session.resetAfterReload();
    this.booted = false;
    this.update({phase: 'webview', flowError: undefined});
  }

  // -------------------------------------------------------------------------
  // Session events
  // -------------------------------------------------------------------------

  private onSessionEvent = (e: SessionEvent) => {
    switch (e.kind) {
      case 'ready':
        void this.onWebViewReady();
        break;
      case 'log':
        this.log(e.message);
        break;
      case 'progress':
        if (e.stage) {
          this.update({busyStage: e.stage});
          this.log(`… ${e.stage.label} (${e.stage.index}/${e.stage.total})`);
        } else {
          this.log(`… ${e.phase}${e.data ? ' ' + JSON.stringify(e.data) : ''}`);
        }
        break;
      case 'prove-metrics': {
        const m = e.metrics;
        this.log(
          `native prove: verified=${m.verified} prove=${m.proveMs}ms fields=${m.proofFields} ` +
            `peakRss=${m.peakRssMb}MB appPeakRss=${m.appPeakRssMb ?? '?'}MB wall=${m.wallMs}ms`,
        );
        this.update({proveMetrics: [...this.snapshot.proveMetrics, m]});
        void this.sampleMemory();
        break;
      }
      case 'crashed':
        break; // handled via onWebViewCrash
    }
  };

  async sampleMemory(): Promise<void> {
    try {
      const memory = JSON.parse(await MemoryInfo.sample()) as MemorySample;
      this.update({memory});
    } catch {}
  }

  /**
   * Drive one controlled PXE sync and refresh the synced-block status. The
   * wallet's PXE runs with autoSync off (see pxe-web boot), so we own the sync
   * cadence: one sync per poll cycle / balance refresh instead of an implicit
   * sync per read. Skipped while a flow is running (its send/simulate already
   * drives exactly one sync). Best-effort; never throws into callers.
   */
  private async syncPxe(): Promise<void> {
    if (this.snapshot.busy || !this.session.ready) {
      return;
    }
    try {
      await this.session.call('sync', {}, 60_000);
      const {blockNumber} = await this.session.call<{blockNumber?: number}>(
        'getSyncedBlock',
        {},
        30_000,
      );
      if (blockNumber !== undefined && blockNumber !== this.snapshot.syncedBlock) {
        this.update({syncedBlock: blockNumber});
      }
    } catch {
      // Network hiccup / not reachable for standalone sync: reads self-sync.
    }
  }

  // -------------------------------------------------------------------------
  // Flows (all: set busy, surface errors, track submitted txs)
  // -------------------------------------------------------------------------

  private async runFlow<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.snapshot.busy) {
      this.log(`flow "${label}" ignored: "${this.snapshot.busy}" still running`);
      return undefined;
    }
    this.update({busy: label, busyStage: undefined, cancellable: true, flowError: undefined});
    try {
      return await fn();
    } catch (e: any) {
      if (isAbortError(e)) {
        this.log(`${label} cancelled`);
        return undefined;
      }
      const message = `${label} failed: ${firstLine(e?.message ?? String(e))}`;
      this.log(message);
      this.update({flowError: message});
      return undefined;
    } finally {
      this.activeCallId = null;
      this.update({busy: null, busyStage: undefined, cancellable: false});
      void this.sampleMemory();
    }
  }

  /**
   * Session call that records its id so the running flow can be cancelled. Flow
   * methods use this instead of `session.call` directly; background calls
   * (poller, balance refresh) use `session.call` so they are not cancelled by
   * the user's Cancel action.
   */
  private flowCall<T>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.session.call<T>(
      method,
      params,
      timeoutMs,
      id => {
        this.activeCallId = id;
      },
      true, // cancellable: arms WebView abort wiring for this flow call
    );
  }

  /** Cancel the running flow (cooperative; lands at the next phase boundary). */
  cancelCurrent(): void {
    if (this.activeCallId != null && this.snapshot.cancellable) {
      this.log(`cancelling "${this.snapshot.busy ?? 'flow'}"…`);
      this.session.abort(this.activeCallId);
    }
  }

  private async track(kind: TxKind, label: string, txHash: string, meta?: Record<string, string>) {
    this.log(`submitted ${label}: ${txHash}`);
    await this.txStore.add({txHash, kind, label, meta});
    this.startPoller();
  }

  /** Onboarding: generate keys (secure RNG), seal, register, deploy. */
  async onboardCreateAccount(alias: string): Promise<void> {
    await this.runFlow('create account', async () => {
      this.log('generating account material (SecureRandom)…');
      const material = await generateAccountMaterial(alias);
      // Seal BEFORE deploying: a crash mid-deploy must not lose the keys.
      this.vault = {version: 1, accounts: [material]};
      await saveVault(this.vault);

      const {address} = await this.flowCall<{address: string}>(
        'createAccount',
        {secret: material.secret, salt: material.salt, signingKey: material.signingKey, alias},
        120_000,
      );
      material.address = address;
      await saveVault(this.vault);
      this.setAccountState(alias, address, false);
      this.log(`account ${address}`);

      this.log('deploying account (sponsored fee, proving on-device)…');
      const {txHash} = await this.flowCall<{txHash: string}>(
        'deployAccount',
        {address},
        FLOW_TIMEOUT_MS,
      );
      material.deployTxHash = txHash;
      await saveVault(this.vault);
      this.setAccountState(alias, address, false, txHash);
      await this.track('account-deploy', `deploy account ${alias}`, txHash);
      this.update({phase: 'ready'});
    });
  }

  async deployToken(name: string, symbol: string): Promise<void> {
    const from = this.requireAccount();
    await this.runFlow(`deploy token ${symbol}`, async () => {
      const res = await this.flowCall<{txHash: string; address: string}>(
        'deployToken',
        {from, name, symbol, decimals: 18},
        FLOW_TIMEOUT_MS,
      );
      await this.tokenStore.addToken({
        address: res.address,
        name,
        symbol,
        decimals: 18,
        deployTxHash: res.txHash,
      });
      await this.track('token-deploy', `deploy ${symbol}`, res.txHash, {address: res.address});
    });
  }

  async mint(token: string, amount: string): Promise<void> {
    const from = this.requireAccount();
    await this.runFlow('mint', async () => {
      const res = await this.flowCall<{txHash: string}>(
        'mintPrivate',
        {token, from, to: from, amount},
        FLOW_TIMEOUT_MS,
      );
      await this.track('mint', `mint ${amount}`, res.txHash, {token});
    });
  }

  async transfer(token: string, to: string, amount: string): Promise<void> {
    const from = this.requireAccount();
    await this.runFlow('transfer', async () => {
      const res = await this.flowCall<{txHash: string}>(
        'transfer',
        {token, from, to, amount},
        FLOW_TIMEOUT_MS,
      );
      await this.track('transfer', `transfer ${amount}`, res.txHash, {token, to});
    });
  }

  async registerSender(address: string): Promise<void> {
    await this.runFlow('register sender', async () => {
      await this.flowCall('registerSender', {address}, 60_000);
      this.log(`sender registered: ${address}`);
    });
  }

  async registerToken(address: string): Promise<void> {
    await this.runFlow('register token', async () => {
      await this.flowCall('registerToken', {address}, 60_000);
      await this.tokenStore.addToken({address, name: 'External', symbol: 'EXT', decimals: 18});
    });
  }

  async refreshBalances(): Promise<void> {
    const account = this.snapshot.account;
    if (!account?.deployed) {
      return;
    }
    // Drive ONE controlled PXE sync before reading, so every balance below runs
    // against the same fresh anchor (the wallet keeps autoSync off — see
    // pxe-web boot). Best-effort: reads still self-sync if this no-ops.
    await this.syncPxe();
    const balances: Record<string, string> = {};
    for (const t of this.tokenStore.tokens()) {
      try {
        const res = await this.session.call<{balance: string}>(
          'balanceOfPrivate',
          {token: t.address, owner: account.address},
          120_000,
        );
        balances[t.address] = res.balance;
      } catch (e: any) {
        this.log(`balance ${t.symbol}: ${firstLine(e?.message ?? String(e))}`);
      }
    }
    this.update({balances});
  }

  /**
   * AMM guided setup, resumable step machine. Each tap advances at most one
   * step, and a step only advances after the previous step's tx CONFIRMED
   * with execution success (a pending tx asks the user to retry later; a
   * dropped/reverted tx rewinds the step so it can be resubmitted).
   */
  async ammSetup(token0: string, token1: string): Promise<void> {
    await this.runFlow('AMM setup', async () => {
      const from = this.requireAccount();
      const amm = this.tokenStore.amm();
      if (!amm) {
        const res = await this.flowCall<{
          liquidityToken: string;
          amm: string;
          txHashes: {liquidityToken: string; amm: string};
        }>('deployAmm', {from, token0, token1}, FLOW_TIMEOUT_MS);
        await this.tokenStore.setAmm({
          step: 'deploying',
          token0,
          token1,
          liquidityToken: res.liquidityToken,
          amm: res.amm,
          txAmm: res.txHashes.amm,
          txLp: res.txHashes.liquidityToken,
        });
        await this.track('amm-deploy', 'deploy AMM', res.txHashes.amm, {amm: res.amm});
        await this.track('token-deploy', 'deploy LP token', res.txHashes.liquidityToken, {
          address: res.liquidityToken,
        });
        return;
      }
      if (amm.step === 'deploying') {
        const ammTx = this.findTx(amm.txAmm);
        const lpTx = this.findTx(amm.txLp);
        if (this.txFailed(ammTx) || this.txFailed(lpTx)) {
          await this.tokenStore.setAmm(undefined);
          throw new Error('AMM deployment failed on-chain — start setup again');
        }
        if (!this.txSucceeded(ammTx) || !this.txSucceeded(lpTx)) {
          throw new Error('AMM deployment still confirming — retry once mined');
        }
        const res = await this.flowCall<{txHash: string}>(
          'setLiquidityMinter',
          {liquidityToken: amm.liquidityToken, amm: amm.amm, from},
          FLOW_TIMEOUT_MS,
        );
        await this.track('amm-set-minter', 'authorize AMM as LP minter', res.txHash);
        await this.tokenStore.setAmm({...amm, step: 'set-minter', txSetMinter: res.txHash});
        return;
      }
      if (amm.step === 'set-minter') {
        const tx = this.findTx(amm.txSetMinter);
        if (this.txFailed(tx) || !amm.txSetMinter) {
          // Resubmit set_minter; the deploys are already confirmed.
          const res = await this.flowCall<{txHash: string}>(
            'setLiquidityMinter',
            {liquidityToken: amm.liquidityToken, amm: amm.amm, from},
            FLOW_TIMEOUT_MS,
          );
          await this.track('amm-set-minter', 'authorize AMM as LP minter (retry)', res.txHash);
          await this.tokenStore.setAmm({...amm, txSetMinter: res.txHash});
          return;
        }
        if (!this.txSucceeded(tx)) {
          throw new Error('set_minter still confirming — retry once mined');
        }
        await this.tokenStore.setAmm({...amm, step: 'ready'});
      }
    });
  }

  private findTx(txHash?: string): TrackedTx | undefined {
    return txHash ? this.txStore.list().find(t => t.txHash === txHash) : undefined;
  }

  private txSucceeded(tx?: TrackedTx): boolean {
    return !!tx && isSucceeded(tx);
  }

  private txFailed(tx?: TrackedTx): boolean {
    return !!tx && (tx.status === 'dropped' || tx.executionResult === 'reverted');
  }

  async ammAddLiquidity(amount0: string, amount1: string): Promise<void> {
    await this.runFlow('add liquidity', async () => {
      const from = this.requireAccount();
      const amm = this.tokenStore.amm();
      if (!amm?.amm || amm.step !== 'ready') {
        throw new Error('AMM not set up');
      }
      const res = await this.flowCall<{txHash: string}>(
        'addLiquidity',
        {
          amm: amm.amm,
          token0: amm.token0,
          token1: amm.token1,
          from,
          amount0,
          amount1,
        },
        FLOW_TIMEOUT_MS,
      );
      await this.track('amm-add-liquidity', `add liquidity ${amount0}/${amount1}`, res.txHash);
    });
  }

  private requireAccount(): string {
    const a = this.snapshot.account;
    if (!a) {
      throw new Error('no account');
    }
    return a.address;
  }

  // -------------------------------------------------------------------------
  // Receipt poller
  // -------------------------------------------------------------------------

  startPoller() {
    if (this.poller) {
      return;
    }
    this.poller = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  private stopPoller() {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const unsettled = this.txStore.unsettled();
    if (unsettled.length === 0) {
      this.stopPoller();
      return;
    }
    if (this.snapshot.phase !== 'ready' && this.snapshot.phase !== 'onboarding') {
      return;
    }
    // One controlled sync per poll cycle keeps receipt reads on a fresh anchor.
    await this.syncPxe();
    for (const tx of unsettled) {
      try {
        const receipt = await this.session.call<{
          status: string;
          blockNumber?: number;
          executionResult?: string;
          error?: string;
        }>('getTxReceipt', {txHash: tx.txHash}, 30_000);
        const before = tx.status;
        await this.txStore.applyReceipt({txHash: tx.txHash, ...receipt});
        const after = this.txStore.list().find(t => t.txHash === tx.txHash);
        if (after && after.status !== before) {
          this.log(
            `tx ${tx.label}: ${after.status}` +
              (after.executionResult ? ` (${after.executionResult})` : '') +
              (receipt.blockNumber ? ` (block ${receipt.blockNumber})` : ''),
          );
          if (tx.kind === 'account-deploy' && isSucceeded(after)) {
            await this.markAccountDeployed();
          }
          if (isSucceeded(after)) {
            void this.refreshBalances();
          }
        }
      } catch {
        // network error: keep tx status, retry next tick
      }
    }
  }

  private async markAccountDeployed(): Promise<void> {
    if (!this.vault || this.vault.accounts.length === 0) {
      return;
    }
    if (!this.vault.accounts[0].deployed) {
      this.vault.accounts[0].deployed = true;
      await saveVault(this.vault);
    }
    const a = this.snapshot.account;
    if (a) {
      this.setAccountState(a.alias, a.address, true, a.deployTxHash);
    }
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0];
}
