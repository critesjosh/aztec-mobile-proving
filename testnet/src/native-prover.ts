/**
 * NativeChonkPrivateKernelProver — a PrivateKernelProver that delegates every
 * kernel *simulation* method to the stock bb.js prover, but routes the final
 * ClientIVC ("Chonk") proof through THIS REPO'S native prover
 * (barretenberg-rs FFI + bbapi) instead of the bb.js WASM.
 *
 * This is the portable core the future React-Native wallet will reuse: it is
 * decoupled from *how* the native prover runs via the `ProverBridge` interface.
 * On Node we use a child-process bridge (host lib or adb-to-device); in RN this
 * becomes a JSI/TurboModule call into the same Rust `noir-prover`.
 *
 * Only `createChonkProof` needs the native prover. The other interface methods
 * (the kernel simulate/generate calls) are kernel-circuit witness generation
 * that already run in the WASM simulator and produce no ClientIVC proof, so we
 * forward them unchanged.
 */
import { flattenChonkProofFields } from '@aztec/bb.js';
import { ChonkProofWithPublicInputs } from '@aztec/stdlib/proofs';
import type { PrivateExecutionStep } from '@aztec/stdlib/kernel';
import { serializePrivateExecutionSteps } from '@aztec/stdlib/kernel';
import type { PrivateKernelProver } from '@aztec/stdlib/interfaces/client';

/**
 * Runs the native prover over a serialized ivc-inputs.msgpack and returns the
 * flat proof fields + hiding-kernel VK. Implementations: host child_process,
 * adb-to-device, or (future) RN native module. Kept intentionally tiny and
 * platform-agnostic so RN can drop in a JSI implementation.
 */
export interface ProverBridge {
  /** Where the proof was produced, for benchmark reporting. */
  readonly location: string;
  /**
   * @param ivcInputsMsgpack serialized PrivateExecutionStep[] (same bytes bb consumes)
   * @returns proof fields as 0x-hex strings (bb.js flattenChonkProofFields layout) + vk hex + timings
   */
  prove(ivcInputsMsgpack: Uint8Array): Promise<NativeProofResult>;
}

export interface NativeProofResult {
  verified: boolean;
  numCircuits: number;
  proveMs: number;
  totalMs: number;
  peakRssMb: number;
  /** 0x-hex, 32-byte fields, order == bb.js flattenChonkProofFields */
  proofFields: string[];
  vkHex: string;
}

export interface NativeProverMetrics {
  native: NativeProofResult;
}

/** Holds the metrics from the most recent createChonkProof, out of band. */
export class NativeProverMetricsSink {
  public last?: NativeProverMetrics;
}

/**
 * Wrap the stock (WASM) prover so that only `createChonkProof` is replaced by
 * the native bridge; every other method (all the kernel simulate/generate
 * calls, computeGateCountForCircuit, and any future additions) is forwarded
 * unchanged via a Proxy. Using a Proxy rather than hand-listing methods keeps
 * this robust across minor interface changes — important since the RN wallet
 * will mirror this against possibly-newer aztec.js.
 */
export function makeNativeChonkProver(
  delegate: PrivateKernelProver,
  bridge: ProverBridge,
  metrics: NativeProverMetricsSink = new NativeProverMetricsSink(),
): PrivateKernelProver {
  const createChonkProof = async (
    executionSteps: PrivateExecutionStep[],
  ): Promise<ChonkProofWithPublicInputs> => {
    const ivcInputs = serializePrivateExecutionSteps(executionSteps);
    const result = await bridge.prove(ivcInputs);
    if (!result.verified) {
      throw new Error('Native prover reported the ClientIVC proof did NOT verify');
    }
    metrics.last = { native: result };
    // proofFields is the same flat Fr[] layout bb.js produces
    // (flattenChonkProofFields); convert 0x-hex to 32-byte buffers.
    void flattenChonkProofFields; // referenced for parity documentation
    return ChonkProofWithPublicInputs.fromBufferArray(result.proofFields.map(hexTo32));
  };

  return new Proxy(delegate, {
    get(target, prop, receiver) {
      if (prop === 'createChonkProof') {
        return createChonkProof;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrivateKernelProver;
}

function hexTo32(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = h.padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
