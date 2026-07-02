import {NativeModules} from 'react-native';

/** Typed access to the wallet's native modules (see android/.../foundation/aztec/wallet). */

export interface ProverModule {
  /** Load bundled SRS into bb's CRS store. Returns JSON status. */
  initSrs(): Promise<string>;
  /** Prove a base64 ivc-inputs.msgpack; returns chonkProve result JSON. */
  chonkProve(ivcInputsB64: string): Promise<string>;
}

export interface SecureKeysModule {
  /** n cryptographically secure random bytes, base64. */
  randomBytes(n: number): Promise<string>;
  /** AES-256-GCM seal (Android Keystore key). base64 in/out. */
  seal(plainB64: string): Promise<string>;
  unseal(sealedB64: string): Promise<string>;
}

export interface MemoryInfoModule {
  /** JSON: totalPssMb, nativeHeapMb, vmRssMb, peakRssMb. */
  sample(): Promise<string>;
}

export interface PxeServerModule {
  /** Start the loopback asset server; resolves the origin (hard error on bind failure). */
  start(): Promise<string>;
}

const mods = NativeModules as {
  Prover: ProverModule;
  SecureKeys: SecureKeysModule;
  MemoryInfo: MemoryInfoModule;
  PxeServer: PxeServerModule;
};

export const Prover = mods.Prover;
export const SecureKeys = mods.SecureKeys;
export const MemoryInfo = mods.MemoryInfo;
export const PxeServer = mods.PxeServer;
