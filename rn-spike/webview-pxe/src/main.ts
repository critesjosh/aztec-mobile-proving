/**
 * WebView-hosted Aztec PXE. Runs the real browser PXE (via BrowserEmbeddedWallet
 * → @aztec/pxe client/lazy) with acvm_js WASM for kernel witgen + IndexedDB for
 * the note/wallet store, and offloads the ClientIVC proof to the React Native
 * host (native Rust prover) over a postMessage bridge.
 *
 * Mirrors the proven testnet/ harness; the only change is the ClientIVC prove
 * call crosses the WebView<->RN boundary instead of a Node child_process.
 *
 * Protocol (RN <-> WebView), JSON messages:
 *   RN -> WebView: { type:'deployAccount', secret, salt, signingKey }
 *                  { type:'proveResult', id, verified, proofFields, vkHex, proveMs, peakRssMb }
 *   WebView -> RN: { type:'ready' } | { type:'log', msg } | { type:'status', phase, data }
 *                  { type:'proveRequest', id, ivcInputsB64 }
 *                  { type:'result', txHash, status, explorer } | { type:'error', error }
 */
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { BrowserEmbeddedWallet } from '@aztec/wallets/embedded';
import { BBLazyPrivateKernelProver } from '@aztec/bb-prover/client/lazy';
import { WASMSimulator } from '@aztec/simulator/client';

import { makeNativeChonkProver, type ProveOverBridge } from './native-prover-bridge.js';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (s: string) => void };
    __aztecOnHostMessage?: (msg: any) => void;
  }
}

function toHost(msg: any) {
  const s = JSON.stringify(msg);
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(s);
  } else {
    // eslint-disable-next-line no-console
    console.log('[WEBVIEW->HOST]', s);
  }
}
const log = (msg: string) => toHost({ type: 'log', msg });

const pending = new Map<number, (r: any) => void>();
let proveSeq = 0;
const PROVE_TIMEOUT_MS = 15 * 60 * 1000;
const proveOverBridge: ProveOverBridge = (ivc: Uint8Array) =>
  new Promise((resolve, reject) => {
    const id = ++proveSeq;
    // Reject (and free the map entry) if the host never posts a proveResult
    // — e.g. a native hang, a lost injected message, or a WebView reload —
    // so the deploy promise fails loudly instead of hanging forever.
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`native prove #${id} timed out after ${PROVE_TIMEOUT_MS} ms`));
      }
    }, PROVE_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    toHost({ type: 'proveRequest', id, ivcInputsB64: bytesToB64(ivc) });
  });

window.__aztecOnHostMessage = async (msg: any) => {
  try {
    if (msg.type === 'proveResult') {
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(msg);
      }
    } else if (msg.type === 'deployAccount') {
      await deployAccount(msg);
    }
  } catch (e: any) {
    toHost({ type: 'error', error: e?.stack ?? String(e) });
  }
};

async function getSponsoredFPC() {
  const { SponsoredFPCContractArtifact } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return { instance, artifact: SponsoredFPCContractArtifact };
}

async function deployAccount(msg: {
  nodeUrl: string;
  sponsoredFpc: string;
  secret: string;
  salt: string;
  signingKey: string;
}) {
  toHost({ type: 'status', phase: 'boot:start', data: { nodeUrl: msg.nodeUrl } });

  // Build the default lazy bb prover, then wrap it so only createChonkProof goes
  // to the native bridge. acvm_js kernel witgen stays in the WebView's WASM.
  const simulator = new WASMSimulator();
  const delegate = new BBLazyPrivateKernelProver(simulator, {});
  const nativeProver = makeNativeChonkProver(delegate, proveOverBridge);

  toHost({ type: 'status', phase: 'wasm:acvm-init' });
  const wallet = await BrowserEmbeddedWallet.create(msg.nodeUrl, {
    ephemeral: true,
    pxe: { proverEnabled: true, proverOrOptions: nativeProver, simulator },
  });
  toHost({ type: 'status', phase: 'pxe:ready' });

  const fpc = await getSponsoredFPC();
  await wallet.registerContract(fpc.instance, fpc.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(AztecAddress.fromStringUnsafe(msg.sponsoredFpc));

  const secret = Fr.fromString(msg.secret);
  const salt = Fr.fromString(msg.salt);
  const signingKey = hexToBytes(msg.signingKey);
  const account = await wallet.createECDSARAccount(secret, salt, signingKey, 'rn-spike');
  toHost({ type: 'status', phase: 'account', data: { address: account.address.toString() } });

  const deployMethod = await account.getDeployMethod();
  toHost({ type: 'status', phase: 'deploy:proving' });
  const { receipt } = await deployMethod.send({
    from: NO_FROM,
    skipClassPublication: false,
    skipInstancePublication: false,
    skipInitialization: false,
    fee: { paymentMethod },
    wait: { timeout: 1200, interval: 5 },
  });
  const txHash = receipt.txHash.toString();
  toHost({
    type: 'result',
    txHash,
    status: receipt.status,
    explorer: `https://testnet.aztecscan.xyz/tx/${txHash}`,
  });
}

function bytesToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    s += String.fromCharCode(u8[i]);
  }
  return btoa(s);
}
function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

toHost({ type: 'ready' });
void log;

// Headless de-risk: allow the driver to inject the deploy request via
// window.__aztecOnHostMessage after the page reports ready.
