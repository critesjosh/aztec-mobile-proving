/**
 * Inside the WebView, this is the PXE's ClientIVC prover. Instead of proving
 * with bb.js WASM (which needs SharedArrayBuffer / cross-origin isolation the
 * WebView doesn't have), it hands the execution steps OUT of the WebView to the
 * React Native host, which proves with the native Rust lib and hands back the
 * flat proof fields. Mirrors testnet/src/native-prover.ts exactly — the only
 * difference is the ProverBridge crosses the WebView<->RN postMessage boundary
 * instead of a Node child_process.
 */
import { flattenChonkProofFields } from '@aztec/bb.js';
import { ChonkProofWithPublicInputs } from '@aztec/stdlib/proofs';
import { serializePrivateExecutionSteps } from '@aztec/stdlib/kernel';
import type { PrivateExecutionStep } from '@aztec/stdlib/kernel';
import type { PrivateKernelProver } from '@aztec/stdlib/interfaces/client';

/** Ask the RN host to prove; returns 0x-hex proof fields + vk. */
export type ProveOverBridge = (ivcInputsMsgpack: Uint8Array) => Promise<{
  verified: boolean;
  proofFields: string[];
  vkHex: string;
  proveMs: number;
  peakRssMb: number;
}>;

export function makeNativeChonkProver(
  delegate: PrivateKernelProver,
  proveOverBridge: ProveOverBridge,
): PrivateKernelProver {
  const createChonkProof = async (
    steps: PrivateExecutionStep[],
  ): Promise<ChonkProofWithPublicInputs> => {
    const ivc = serializePrivateExecutionSteps(steps);
    const res = await proveOverBridge(ivc);
    if (!res.verified) {
      throw new Error('native prover: ClientIVC proof did not verify');
    }
    void flattenChonkProofFields; // parity marker (RN-side flattens identically)
    return ChonkProofWithPublicInputs.fromBufferArray(res.proofFields.map(hexTo32));
  };

  return new Proxy(delegate, {
    get(target, prop, recv) {
      if (prop === 'createChonkProof') {
        return createChonkProof;
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as PrivateKernelProver;
}

function hexTo32(hex: string): Uint8Array {
  const h = (hex.startsWith('0x') ? hex.slice(2) : hex).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
