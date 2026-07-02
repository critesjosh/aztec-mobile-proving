/**
 * WebView-hosted Aztec wallet PXE. Runs the real browser PXE
 * (BrowserEmbeddedWallet -> @aztec/pxe client/lazy) with acvm_js WASM for
 * kernel witgen and a persistent IndexedDB PXE data store, and offloads the
 * ClientIVC proof to the React Native host (native Rust prover) over the
 * proven postMessage bridge from rn-spike.
 *
 * Protocol (RN <-> WebView), JSON messages:
 *   RN -> WebView: { type:'rpc', id, method, params }
 *                  { type:'proveResult', id, verified, proofFields, vkHex, proveMs, peakRssMb }
 *   WebView -> RN: { type:'ready' } | { type:'log', msg }
 *                  { type:'progress', id, phase, data? }
 *                  { type:'rpcResult', id, ok, result?, error? }
 *                  { type:'proveRequest', id, ivcInputsB64 }
 *
 * Key custody: account secrets arrive per-session via `restoreAccounts` /
 * `createAccount` params and live only in this page's memory. The wallet DB
 * (which would persist secrets plaintext in IndexedDB) is overridden with an
 * in-memory store; the PXE data store persists (notes/contracts/sync state).
 * NEVER log or echo params of account methods.
 */
import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams, NO_WAIT } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { TxHash } from '@aztec/aztec.js/tx';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
// The "browser" export condition resolves this to BrowserEmbeddedWallet.
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { openMemoryStore } from './mem-store.js';
import { BBLazyPrivateKernelProver } from '@aztec/bb-prover/client/lazy';
import { WASMSimulator } from '@aztec/simulator/client';
import type { AccountManager } from '@aztec/aztec.js/wallet';

import { makeNativeChonkProver, type ProveOverBridge } from './native-prover-bridge.js';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (s: string) => void };
    __aztecOnHostMessage?: (msg: unknown) => void;
  }
}

function toHost(msg: Record<string, unknown>) {
  const s = JSON.stringify(msg);
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(s);
  } else {
    // eslint-disable-next-line no-console
    console.log('[WEBVIEW->HOST]', s);
  }
}
const log = (msg: string) => toHost({ type: 'log', msg });

// ---------------------------------------------------------------------------
// Native prove bridge (unchanged, proven protocol from rn-spike)
// ---------------------------------------------------------------------------

const provePending = new Map<number, (r: any) => void>();
let proveSeq = 0;
const PROVE_TIMEOUT_MS = 15 * 60 * 1000;
const proveOverBridge: ProveOverBridge = (ivc: Uint8Array) =>
  new Promise((resolve, reject) => {
    const id = ++proveSeq;
    const timer = setTimeout(() => {
      if (provePending.delete(id)) {
        reject(new Error(`native prove #${id} timed out after ${PROVE_TIMEOUT_MS} ms`));
      }
    }, PROVE_TIMEOUT_MS);
    provePending.set(id, r => {
      clearTimeout(timer);
      resolve(r);
    });
    toHost({ type: 'proveRequest', id, ivcInputsB64: bytesToB64(ivc) });
  });

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Session {
  wallet: EmbeddedWallet;
  node: ReturnType<typeof createAztecNodeClient>;
  paymentMethod: SponsoredFeePaymentMethod;
  /** address (0x…) -> AccountManager for accounts registered this session. */
  accounts: Map<string, AccountManager>;
}
let session: Session | undefined;

function requireSession(): Session {
  if (!session) {
    throw new Error('not booted: call boot first');
  }
  return session;
}

const fee = () => ({ paymentMethod: requireSession().paymentMethod });

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

type Emit = (phase: string, data?: Record<string, unknown>) => void;

const handlers: Record<string, (params: any, emit: Emit) => Promise<unknown>> = {
  /**
   * Boot the PXE + embedded wallet. `persistent: true` => PXE data store in
   * IndexedDB (survives restarts) with the wallet DB forced in-memory so
   * account secrets are never persisted by the WebView (they live sealed on
   * the RN side).
   */
  async boot(params: { nodeUrl: string; sponsoredFpc: string; persistent: boolean }, emit) {
    if (session) {
      throw new Error('already booted');
    }
    emit('boot:start', { nodeUrl: params.nodeUrl });
    const simulator = new WASMSimulator();
    const delegate = new BBLazyPrivateKernelProver(simulator, {});
    const nativeProver = makeNativeChonkProver(delegate, proveOverBridge);
    emit('wasm:acvm-init');
    const wallet = await EmbeddedWallet.create(params.nodeUrl, {
      ephemeral: !params.persistent,
      // ALWAYS a genuinely in-memory wallet DB: EmbeddedWallet's WalletDB persists
      // account secret keys, and even the kv-store "ephemeral" IndexedDB
      // store writes to disk (random-named DB). See mem-store.ts.
      walletDb: { store: openMemoryStore() },
      pxe: { proverEnabled: true, proverOrOptions: nativeProver, simulator },
    });
    const node = createAztecNodeClient(params.nodeUrl);
    emit('pxe:created');

    const { SponsoredFPCContractArtifact } = await import('@aztec/noir-contracts.js/SponsoredFPC');
    const fpcInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
      salt: new Fr(SPONSORED_FPC_SALT),
    });
    const declaredFpc = AztecAddress.fromStringUnsafe(params.sponsoredFpc);
    if (!fpcInstance.address.equals(declaredFpc)) {
      throw new Error(
        `SponsoredFPC mismatch: derived ${fpcInstance.address} != configured ${params.sponsoredFpc}`,
      );
    }
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    const paymentMethod = new SponsoredFeePaymentMethod(declaredFpc);

    session = { wallet, node, paymentMethod, accounts: new Map() };
    const info = await node.getNodeInfo();
    emit('pxe:ready');
    return {
      l1ChainId: info.l1ChainId,
      rollupVersion: info.rollupVersion,
      nodeVersion: info.nodeVersion,
    };
  },

  /**
   * Fail-fast storage probe (wallet/PLAN.md M1): raw IndexedDB marker to
   * verify persistence across app restarts, plus OPFS feature probing for the
   * encrypted-store stretch. Independent of the PXE (works pre-boot).
   */
  async storageProbe() {
    const idb = await probeIndexedDb();
    const opfs = await probeOpfs();
    return {
      origin: location.origin,
      secureContext: window.isSecureContext,
      hasCryptoSubtle: !!crypto?.subtle,
      persistentStorage: await navigator.storage?.persisted?.().catch(() => undefined),
      idb,
      opfs,
    };
  },

  /** Current chain tip, for status display + poller scheduling. */
  async getBlockNumber() {
    return await requireSession().node.getBlockNumber();
  },

  /**
   * Poll a tx receipt; returns plain JSON of the v5 TxReceipt union,
   * including executionResult (success|reverted, mined txs only) and the
   * drop error (dropped txs only) — a mined-but-reverted tx must not be
   * treated as success by the RN side.
   */
  async getTxReceipt(params: { txHash: string }) {
    const receipt = await requireSession().node.getTxReceipt(TxHash.fromString(params.txHash));
    const r = receipt as any;
    return {
      status: receipt.status,
      blockNumber: r.blockNumber !== undefined ? Number(r.blockNumber) : undefined,
      executionResult: r.executionResult,
      error: r.error,
    };
  },

  /**
   * Create (register) an ECDSA-R1 account in this session from key material.
   * Idempotent against a persistent PXE store: re-registering the same
   * account is allowed. Returns the derived address; deployment is separate.
   */
  async createAccount(params: { secret: string; salt: string; signingKey: string; alias?: string }) {
    const s = requireSession();
    const account = await s.wallet.createECDSARAccount(
      Fr.fromString(params.secret),
      Fr.fromString(params.salt),
      hexToBuffer(params.signingKey),
      params.alias ?? 'account',
    );
    const address = account.address.toString();
    s.accounts.set(address, account);
    return { address };
  },

  /** Re-register accounts from RN sealed storage on boot. */
  async restoreAccounts(params: {
    accounts: { secret: string; salt: string; signingKey: string; alias?: string }[];
  }) {
    const restored: { address: string }[] = [];
    for (const a of params.accounts) {
      const r = (await handlers.createAccount(a, () => {})) as { address: string };
      restored.push(r);
    }
    return { accounts: restored };
  },

  /**
   * Deploy a previously created/restored account. Uses the spike's proven
   * options: self-deploy (NO_FROM) with class publication in-tx (the ECDSA-R
   * class-existence read fails on this testnet otherwise).
   */
  async deployAccount(params: { address: string }, emit) {
    const s = requireSession();
    const account = s.accounts.get(params.address);
    if (!account) {
      throw new Error(`unknown account ${params.address}; createAccount/restoreAccounts first`);
    }
    const deployMethod = await account.getDeployMethod();
    emit('deploy:proving');
    const { txHash } = await deployMethod.send({
      from: NO_FROM,
      skipClassPublication: false,
      skipInstancePublication: false,
      skipInitialization: false,
      fee: fee(),
      wait: NO_WAIT,
    });
    return { txHash: txHash.toString() };
  },

  /** Deploy a Token contract owned by `from`. */
  async deployToken(params: { from: string; name: string; symbol: string; decimals: number }, emit) {
    const s = requireSession();
    const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
    const from = AztecAddress.fromStringUnsafe(params.from);
    const deploy = TokenContract.deploy(s.wallet, from, params.name, params.symbol, params.decimals);
    emit('deploy-token:proving');
    // send() locks the deployer; getInstance() is only valid afterwards.
    const { txHash } = await deploy.send({ from, fee: fee(), wait: NO_WAIT });
    const instance = await deploy.getInstance();
    return { txHash: txHash.toString(), address: instance.address.toString() };
  },

  /** Privately mint `amount` of `token` to `to` (minter must be `from`). */
  async mintPrivate(params: { token: string; from: string; to: string; amount: string }, emit) {
    const s = requireSession();
    const token = await tokenAt(params.token);
    const from = AztecAddress.fromStringUnsafe(params.from);
    const to = AztecAddress.fromStringUnsafe(params.to);
    emit('mint:proving');
    const { txHash } = await token.methods
      .mint_to_private(to, BigInt(params.amount))
      .send({ from, fee: fee(), wait: NO_WAIT });
    return { txHash: txHash.toString() };
  },

  /** Private transfer of `amount` of `token` from `from` to `to`. */
  async transfer(params: { token: string; from: string; to: string; amount: string }, emit) {
    const token = await tokenAt(params.token);
    const from = AztecAddress.fromStringUnsafe(params.from);
    const to = AztecAddress.fromStringUnsafe(params.to);
    emit('transfer:proving');
    const { txHash } = await token.methods
      .transfer(to, BigInt(params.amount))
      .send({ from, fee: fee(), wait: NO_WAIT });
    return { txHash: txHash.toString() };
  },

  /** Private balance via the Token utility function (simulated locally). */
  async balanceOfPrivate(params: { token: string; owner: string }) {
    const token = await tokenAt(params.token);
    const owner = AztecAddress.fromStringUnsafe(params.owner);
    const { result } = await token.methods.balance_of_private(owner).simulate({ from: owner });
    return { balance: (result as bigint).toString() };
  },

  /**
   * Register an already-deployed Token at `address` (e.g. received tokens):
   * fetches the instance from the node and registers it with the bundled
   * Token artifact.
   */
  async registerToken(params: { address: string }) {
    const s = requireSession();
    const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
    const address = AztecAddress.fromStringUnsafe(params.address);
    const instance = await s.node.getContract(address);
    if (!instance) {
      throw new Error(`no contract on-chain at ${params.address}`);
    }
    await s.wallet.registerContract(instance, TokenContract.artifact);
    return { address: params.address };
  },

  /** Register a counterparty as a sender so its notes are discoverable. */
  async registerSender(params: { address: string; alias?: string }) {
    const s = requireSession();
    await s.wallet.registerSender(
      AztecAddress.fromStringUnsafe(params.address),
      params.alias ?? params.address.slice(0, 10),
    );
    return {};
  },

  /**
   * Deploy the AMM stack for token0/token1: liquidity Token + AMM, then
   * set_minter(amm) on the liquidity token. Emits per-step progress; each tx
   * hash is returned so RN can track/resume the guided setup.
   */
  async deployAmm(params: { from: string; token0: string; token1: string }, emit) {
    const s = requireSession();
    const from = AztecAddress.fromStringUnsafe(params.from);
    const token0 = AztecAddress.fromStringUnsafe(params.token0);
    const token1 = AztecAddress.fromStringUnsafe(params.token1);
    const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
    const { AMMContract } = await import('@aztec/noir-contracts.js/AMM');

    emit('amm:liquidity-token:proving');
    const lpDeploy = TokenContract.deploy(s.wallet, from, 'Liquidity', 'LPT', 18);
    const lp = await lpDeploy.send({ from, fee: fee(), wait: NO_WAIT });
    const lpInstance = await lpDeploy.getInstance();

    emit('amm:contract:proving', { liquidityToken: lpInstance.address.toString() });
    const ammDeploy = AMMContract.deploy(s.wallet, token0, token1, lpInstance.address);
    const amm = await ammDeploy.send({ from, fee: fee(), wait: NO_WAIT });
    const ammInstance = await ammDeploy.getInstance();

    return {
      liquidityToken: lpInstance.address.toString(),
      amm: ammInstance.address.toString(),
      txHashes: {
        liquidityToken: lp.txHash.toString(),
        amm: amm.txHash.toString(),
      },
    };
  },

  /** set_minter(amm, true) on the liquidity token (separate resumable step). */
  async setLiquidityMinter(params: { liquidityToken: string; amm: string; from: string }, emit) {
    const token = await tokenAt(params.liquidityToken);
    const from = AztecAddress.fromStringUnsafe(params.from);
    const amm = AztecAddress.fromStringUnsafe(params.amm);
    emit('amm:set-minter:proving');
    const { txHash } = await token.methods
      .set_minter(amm, true)
      .send({ from, fee: fee(), wait: NO_WAIT });
    return { txHash: txHash.toString() };
  },

  /**
   * AMM add_liquidity: the 14-circuit flow. Two authwits authorize the AMM to
   * pull token0/token1 via transfer_to_public_and_prepare_private_balance_increase
   * (client-flows/e2e_amm pattern), then add_liquidity carries them.
   */
  async addLiquidity(
    params: {
      amm: string;
      token0: string;
      token1: string;
      from: string;
      amount0: string;
      amount1: string;
      amount0Min?: string;
      amount1Min?: string;
    },
    emit,
  ) {
    const s = requireSession();
    const { AMMContract } = await import('@aztec/noir-contracts.js/AMM');
    const from = AztecAddress.fromStringUnsafe(params.from);
    const amm = await AMMContract.at(AztecAddress.fromStringUnsafe(params.amm), s.wallet);
    const token0 = await tokenAt(params.token0);
    const token1 = await tokenAt(params.token1);
    const amount0 = BigInt(params.amount0);
    const amount1 = BigInt(params.amount1);
    const amount0Min = BigInt(params.amount0Min ?? params.amount0);
    const amount1Min = BigInt(params.amount1Min ?? params.amount1);

    emit('amm:authwits');
    const nonce = Fr.random();
    // The {caller, action} intent (ContractFunctionInteractionCallIntent) is
    // accepted at runtime by computeAuthWitMessageHash; createAuthWit's
    // declared param type is narrower, hence the cast (same usage as the
    // aztec-packages client-flows/e2e AMM tests).
    const intent0 = {
      caller: amm.address,
      action: token0.methods.transfer_to_public_and_prepare_private_balance_increase(
        from,
        amm.address,
        amount0,
        nonce,
      ),
    };
    const intent1 = {
      caller: amm.address,
      action: token1.methods.transfer_to_public_and_prepare_private_balance_increase(
        from,
        amm.address,
        amount1,
        nonce,
      ),
    };
    type CreateAuthWitIntent = Parameters<typeof s.wallet.createAuthWit>[1];
    const token0Authwit = await s.wallet.createAuthWit(from, intent0 as unknown as CreateAuthWitIntent);
    const token1Authwit = await s.wallet.createAuthWit(from, intent1 as unknown as CreateAuthWitIntent);

    emit('amm:add-liquidity:proving');
    const { txHash } = await amm.methods
      .add_liquidity(amount0, amount1, amount0Min, amount1Min, nonce)
      .with({ authWitnesses: [token0Authwit, token1Authwit] })
      .send({ from, fee: fee(), wait: NO_WAIT });
    return { txHash: txHash.toString() };
  },
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

window.__aztecOnHostMessage = async (raw: unknown) => {
  const msg = raw as any;
  if (!msg || typeof msg !== 'object') {
    return;
  }
  if (msg.type === 'proveResult') {
    if (typeof msg.id !== 'number') {
      return;
    }
    const cb = provePending.get(msg.id);
    if (cb) {
      provePending.delete(msg.id);
      cb(msg);
    }
    return;
  }
  if (msg.type !== 'rpc') {
    return;
  }
  const { id, method, params } = msg;
  if (typeof id !== 'number' || typeof method !== 'string') {
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    toHost({ type: 'rpcResult', id, ok: false, error: `unknown method ${method}` });
    return;
  }
  try {
    const emit: Emit = (phase, data) => toHost({ type: 'progress', id, phase, data });
    const result = await handler(params ?? {}, emit);
    toHost({ type: 'rpcResult', id, ok: true, result });
  } catch (e: any) {
    // Errors flow into the RN log panel + logcat. Methods whose params carry
    // key material get REDACTED errors: no stack, and any long hex payload
    // stripped (e.g. Fr.fromString echoes its rejected input — a corrupted
    // vault value must not end up in logs).
    const error = KEY_BEARING_METHODS.has(method)
      ? redactHex(String(e?.message ?? e).split('\n')[0])
      : (e?.stack ?? String(e));
    toHost({ type: 'rpcResult', id, ok: false, error });
  }
};

const KEY_BEARING_METHODS = new Set(['createAccount', 'restoreAccounts']);

/** Replace any >=16-hex-digit run (with or without 0x) by a redaction mark. */
function redactHex(s: string): string {
  return s.replace(/(0x)?[0-9a-fA-F]{16,}/g, '0x…redacted…');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tokenAt(address: string) {
  const s = requireSession();
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  return await TokenContract.at(AztecAddress.fromStringUnsafe(address), s.wallet);
}

async function probeIndexedDb(): Promise<{ ok: boolean; hadMarker: boolean; marker?: string; error?: string }> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('wallet_persistence_probe', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const read = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get('marker');
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(`booted@${new Date().toISOString()}`, 'marker');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { ok: true, hadMarker: read !== undefined, marker: read };
  } catch (e: any) {
    return { ok: false, hadMarker: false, error: String(e?.message ?? e) };
  }
}

async function probeOpfs(): Promise<{ getDirectory: boolean; dirOpens: boolean; error?: string }> {
  const getDirectory = typeof navigator.storage?.getDirectory === 'function';
  if (!getDirectory) {
    return { getDirectory, dirOpens: false };
  }
  try {
    await navigator.storage.getDirectory();
    return { getDirectory, dirOpens: true };
  } catch (e: any) {
    return { getDirectory, dirOpens: false, error: String(e?.message ?? e) };
  }
}

function bytesToB64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

toHost({ type: 'ready' });
void log;
