/**
 * Testnet connection + fee-payment setup, plus the wiring that injects THIS
 * REPO'S native prover into the EmbeddedWallet's PXE.
 *
 * PORTABILITY: everything here except `createStore`/bridge selection is
 * aztec.js and works unchanged in React Native. The RN wallet will reuse this
 * file almost verbatim, swapping (1) the ProverBridge for a native-module
 * bridge and (2) the PXE store backend (see punch-list in testnet/README).
 */
import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { createLogger } from '@aztec/foundation/log';
import { NodeEmbeddedWallet } from '@aztec/wallets/embedded';
import { BBBundlePrivateKernelProver } from '@aztec/bb-prover/client/bundle';
import { WASMSimulator } from '@aztec/simulator/client';

import {
  makeNativeChonkProver,
  NativeProverMetricsSink,
  type ProverBridge,
} from './native-prover.js';

export interface TestnetConfig {
  nodeUrl: string;
  sponsoredFpc: AztecAddress;
}

export function testnetConfigFromEnv(): TestnetConfig {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
  const fpc = process.env.SPONSORED_FPC_ADDRESS;
  if (!fpc) {
    throw new Error('SPONSORED_FPC_ADDRESS not set (see .env.example)');
  }
  return { nodeUrl, sponsoredFpc: AztecAddress.fromStringUnsafe(fpc) };
}

/** The canonical SponsoredFPC contract instance (deterministic, fixed salt). */
export async function getSponsoredFPCContract() {
  const { SponsoredFPCContractArtifact } = await import('@aztec/noir-contracts.js/SponsoredFPC');
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return { instance, artifact: SponsoredFPCContractArtifact };
}

export interface WalletBundle {
  node: ReturnType<typeof createAztecNodeClient>;
  wallet: NodeEmbeddedWallet;
  paymentMethod: SponsoredFeePaymentMethod;
  metrics: NativeProverMetricsSink;
  proverLocation: string;
}

/**
 * Connect to the testnet node, build an EmbeddedWallet whose PXE proves the
 * ClientIVC step via `bridge` (our native prover), and register the
 * SponsoredFPC so fees are paid by it (no fee-juice bridging).
 */
export async function connectWithNativeProver(
  cfg: TestnetConfig,
  bridge: ProverBridge,
  opts: { ephemeral?: boolean } = {},
): Promise<WalletBundle> {
  const log = createLogger('mobile-proving:testnet');
  const node = createAztecNodeClient(cfg.nodeUrl);
  log.info(`Waiting for node at ${cfg.nodeUrl} ...`);
  await waitForNode(node);

  const metrics = new NativeProverMetricsSink();

  // Build the same prover PXE would build by default (kernel simulation over
  // WASM), then wrap it so only the ClientIVC proof goes to the native bridge.
  const simulator = new WASMSimulator();
  const delegate = new BBBundlePrivateKernelProver(simulator, {
    logger: log.createChild('bb-kernel'),
  });
  const nativeProver = makeNativeChonkProver(delegate, bridge, metrics);

  const wallet = await NodeEmbeddedWallet.create(node, {
    ephemeral: opts.ephemeral ?? true,
    pxe: { proverEnabled: true, proverOrOptions: nativeProver, simulator },
  });

  // Register SponsoredFPC so PXE can build fee-payment logic.
  const fpc = await getSponsoredFPCContract();
  await wallet.registerContract(fpc.instance, fpc.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(cfg.sponsoredFpc);

  return { node, wallet, paymentMethod, metrics, proverLocation: bridge.location };
}

/** Pick a bridge from env: BRIDGE=adb uses the device; anything else = host. */
export async function bridgeFromEnv(): Promise<ProverBridge> {
  const kind = (process.env.BRIDGE ?? 'host').toLowerCase();
  if (kind === 'adb') {
    const { AdbProverBridge } = await import('./bridge/adb.js');
    return new AdbProverBridge({
      serial: process.env.ADB_SERIAL,
      deviceDir: process.env.DEVICE_PROVER_DIR,
    });
  }
  const { HostProverBridge } = await import('./bridge/host.js');
  const repo = new URL('../..', import.meta.url).pathname;
  return new HostProverBridge({
    proverBin: process.env.PROVER_BIN ?? `${repo}/target/release/bb-chonk-prove`,
    g1: process.env.SRS_G1 ?? `${repo}/android/app/src/main/assets/srs/bn254_g1.dat`,
    g2: process.env.SRS_G2 ?? `${repo}/android/app/src/main/assets/srs/bn254_g2.dat`,
    grumpkinG1: process.env.SRS_GRUMPKIN ?? `${repo}/android/app/src/main/assets/srs/grumpkin_g1.dat`,
  });
}
