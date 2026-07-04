/**
 * Account key custody. The vault (account secrets/salts/signing keys) is only
 * ever stored as an AES-256-GCM sealed blob whose key lives in the Android
 * Keystore (SecureKeysModule). Unsealed material exists in JS memory for the
 * session and is handed to the WebView PXE at boot; it never touches disk,
 * logs, or git.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SecureKeys} from '../native/modules';
import {base64ToHex, base64ToUtf8, utf8ToBase64} from '../util/bytes';

export interface StoredAccount {
  alias: string;
  type: 'ecdsasecp256r1';
  /** 0x-hex Fr (31 random bytes, always < field modulus). */
  secret: string;
  salt: string;
  /** 0x-hex 32-byte ECDSA P-256 signing key. */
  signingKey: string;
  /** Derived address, cached after createAccount. */
  address?: string;
  deployTxHash?: string;
  deployed: boolean;
}

export interface Vault {
  version: 1;
  accounts: StoredAccount[];
}

const VAULT_KEY = 'wallet/vault.sealed';
const STORE_KEY_KEY = 'wallet/store-key.sealed';

export async function loadVault(): Promise<Vault | null> {
  const sealed = await AsyncStorage.getItem(VAULT_KEY);
  if (!sealed) {
    return null;
  }
  const plainB64 = await SecureKeys.unseal(sealed);
  const vault = JSON.parse(base64ToUtf8(plainB64)) as Vault;
  if (vault.version !== 1) {
    throw new Error(`unsupported vault version ${vault.version}`);
  }
  return vault;
}

export async function saveVault(vault: Vault): Promise<void> {
  const sealed = await SecureKeys.seal(utf8ToBase64(JSON.stringify(vault)));
  await AsyncStorage.setItem(VAULT_KEY, sealed);
}

/** Destroy the vault (explicit user reset only). */
export async function deleteVault(): Promise<void> {
  await AsyncStorage.removeItem(VAULT_KEY);
}

/**
 * Get (or create + persist) the 32-byte key that encrypts the on-device PXE
 * data store. Generated with the platform secure RNG and stored ONLY as a
 * Keystore-sealed blob (same seam as the account vault); the raw key (base64)
 * lives in JS memory for the session and is handed to the WebView at boot so
 * the persistent PXE store — which holds viewing/nullifier key material derived
 * from the account secret — is encrypted at rest under a key the Android
 * Keystore holds, closing the "privacy-sensitive material in a plaintext store"
 * gap. Returns base64 of 32 bytes.
 *
 * NOTE: the sealed store key and the encrypted store must be reset together; a
 * reset that drops one without the other orphans the store (see resetStoreKey).
 */
export async function getOrCreateStoreKey(): Promise<string> {
  const sealed = await AsyncStorage.getItem(STORE_KEY_KEY);
  if (sealed) {
    return await SecureKeys.unseal(sealed);
  }
  const keyB64 = await SecureKeys.randomBytes(32);
  await AsyncStorage.setItem(STORE_KEY_KEY, await SecureKeys.seal(keyB64));
  return keyB64;
}

/** Drop the sealed store key (only alongside clearing the encrypted store). */
export async function resetStoreKey(): Promise<void> {
  await AsyncStorage.removeItem(STORE_KEY_KEY);
}

/** Fresh ECDSA-R1 account material from the platform secure RNG. */
export async function generateAccountMaterial(alias: string): Promise<StoredAccount> {
  // 31 bytes for Fr values (< BN254 field modulus by construction, same
  // convention the spike used); 32 bytes for the ECDSA P-256 signing key.
  const [secret, salt, signingKey] = await Promise.all([
    SecureKeys.randomBytes(31),
    SecureKeys.randomBytes(31),
    SecureKeys.randomBytes(32),
  ]);
  return {
    alias,
    type: 'ecdsasecp256r1',
    secret: base64ToHex(secret),
    salt: base64ToHex(salt),
    signingKey: base64ToHex(signingKey),
    deployed: false,
  };
}
