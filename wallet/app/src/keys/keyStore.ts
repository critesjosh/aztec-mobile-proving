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
