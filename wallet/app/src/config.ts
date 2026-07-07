/**
 * Public network configuration (no secrets — key material lives sealed in the
 * Android Keystore, never in code or env files). Pinned to aztec-packages
 * v5.0.0-rc.2 / Aztec testnet.
 */
export const NODE_URL = 'https://v5.testnet.rpc.aztec-labs.com';
export const SPONSORED_FPC =
  '0x1969946536f0c09269e2c75e414eef4e21a76e763c5514125208db33d7d944d7';
export const EXPLORER_TX_BASE = 'https://testnet.aztecscan.xyz/tx-effects/';

/** Fixed loopback port — must match PxeServerModule.PORT (origin keys IndexedDB). */
export const PXE_ORIGIN = 'http://127.0.0.1:38271';

/** RPC timeouts. Proving flows legitimately run minutes on testnet. */
export const RPC_TIMEOUT_MS = 60_000;
export const BOOT_TIMEOUT_MS = 180_000;
export const FLOW_TIMEOUT_MS = 15 * 60_000;

/** Receipt poller. */
export const POLL_INTERVAL_MS = 5_000;
/** Grace window before trusting a DROPPED status for a fresh tx. */
export const DROPPED_GRACE_MS = 120_000;
/** Give up marking a tx dropped-after-grace once it is this old. */
export const PENDING_MAX_AGE_MS = 30 * 60_000;
