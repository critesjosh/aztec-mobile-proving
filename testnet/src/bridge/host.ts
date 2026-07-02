/**
 * NODE-SPECIFIC bridge: runs the native prover CLI (`bb-chonk-prove`) as a
 * host child process. This proves with the SAME native Rust code that runs on
 * the phone, just on the host CPU (fallback when no device is attached).
 *
 * RN replacement: swap this whole file for a JSI/TurboModule call into the same
 * `noir-prover` Rust lib compiled for the device. The `ProverBridge` contract
 * (bytes in -> {proofFields, vk} out) is identical.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NativeProofResult, ProverBridge } from '../native-prover.js';

export interface HostBridgeConfig {
  /** Path to the bb-chonk-prove binary (built by cargo). */
  proverBin: string;
  /** SRS asset paths (bb CRS layout). */
  g1: string;
  g2: string;
  grumpkinG1: string;
  bn254Points?: number;
  grumpkinPoints?: number;
}

export class HostProverBridge implements ProverBridge {
  readonly location = 'host (native lib, x86_64)';
  constructor(private cfg: HostBridgeConfig) {}

  async prove(ivcInputsMsgpack: Uint8Array): Promise<NativeProofResult> {
    const dir = mkdtempSync(join(tmpdir(), 'chonk-'));
    const inPath = join(dir, 'ivc-inputs.msgpack');
    const outPath = join(dir, 'out.json');
    try {
      writeFileSync(inPath, ivcInputsMsgpack);
      execFileSync(
        this.cfg.proverBin,
        [
          inPath,
          this.cfg.g1,
          this.cfg.g2,
          this.cfg.grumpkinG1,
          outPath,
          String(this.cfg.bn254Points ?? 1 << 19),
          String(this.cfg.grumpkinPoints ?? 1 << 16),
        ],
        { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
      );
      return parseResult(readFileSync(outPath, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function parseResult(json: string): NativeProofResult {
  const j = JSON.parse(json);
  return {
    verified: j.verified,
    numCircuits: j.num_circuits,
    proveMs: j.prove_ms,
    totalMs: j.total_ms,
    peakRssMb: j.peak_rss_mb,
    proofFields: (j.proof_fields as string[]).map((h) => (h.startsWith('0x') ? h : `0x${h}`)),
    vkHex: j.vk.startsWith('0x') ? j.vk : `0x${j.vk}`,
  };
}
