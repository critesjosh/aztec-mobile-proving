/**
 * NODE-SPECIFIC bridge: proves ON THE ANDROID DEVICE/EMULATOR via adb.
 * Pushes the ivc-inputs.msgpack + a device-native bb-chonk-prove binary,
 * runs it on the device, and pulls back the proof fields. This makes the proof
 * that lands on testnet one that was PRODUCED ON THE PHONE.
 *
 * Requires (one-time, see testnet/README): the SRS assets already pushed to
 * DEVICE_DIR, and an aarch64/x86_64 bb-chonk-prove binary pushed there too.
 *
 * RN replacement: not needed — in the RN wallet the prover runs in-process via
 * a native module, so there is no adb round-trip at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NativeProofResult, ProverBridge } from '../native-prover.js';
import { parseResult } from './host.js';

/** Single-quote a value for safe use inside an `adb shell` command string. */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export interface AdbBridgeConfig {
  /** adb serial (optional; defaults to the only attached device). */
  serial?: string;
  /** On-device working dir holding the pushed binary + SRS. */
  deviceDir?: string;
  /** On-device binary name. */
  proverBin?: string;
  /** On-device SRS filenames (already pushed). */
  g1?: string;
  g2?: string;
  grumpkinG1?: string;
  bn254Points?: number;
  grumpkinPoints?: number;
}

export class AdbProverBridge implements ProverBridge {
  readonly location: string;
  private dir: string;
  private bin: string;
  constructor(private cfg: AdbBridgeConfig = {}) {
    this.dir = cfg.deviceDir ?? '/data/local/tmp/aztec-prover';
    this.bin = cfg.proverBin ?? 'bb-chonk-prove';
    this.location = `android device via adb (${cfg.serial ?? 'default'})`;
  }

  private adb(args: string[], opts: { input?: Buffer } = {}) {
    const full = this.cfg.serial ? ['-s', this.cfg.serial, ...args] : args;
    return execFileSync('adb', full, {
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
    });
  }

  async prove(ivcInputsMsgpack: Uint8Array): Promise<NativeProofResult> {
    const local = mkdtempSync(join(tmpdir(), 'chonk-adb-'));
    const localIn = join(local, 'ivc-inputs.msgpack');
    const localOut = join(local, 'out.json');
    const devIn = `${this.dir}/ivc-inputs.msgpack`;
    const devOut = `${this.dir}/out.json`;
    try {
      writeFileSync(localIn, ivcInputsMsgpack);
      this.adb(['push', localIn, devIn]);
      // `cd && ./bin` needs a device shell; single-quote every interpolated
      // path so config values containing spaces/metacharacters are inert.
      const cmd =
        `cd ${sq(this.dir)} && ./${sq(this.bin)} ${sq(devIn)} ` +
        `${sq(this.cfg.g1 ?? 'bn254_g1.dat')} ${sq(this.cfg.g2 ?? 'bn254_g2.dat')} ` +
        `${sq(this.cfg.grumpkinG1 ?? 'grumpkin_g1.dat')} ${sq(devOut)} ` +
        `${Number(this.cfg.bn254Points ?? 1 << 19)} ${Number(this.cfg.grumpkinPoints ?? 1 << 16)}`;
      this.adb(['shell', cmd]);
      this.adb(['pull', devOut, localOut]);
      return parseResult(readFileSync(localOut, 'utf8'));
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }
}
