# Aztec mobile wallet (Android)

A React Native wallet that runs a **full Aztec PXE on-device** and proves
transactions **natively**: account creation/deployment, private token
transfers, and AMM add-liquidity against **Aztec testnet**, with every
ClientIVC proof produced on the phone by this repo's native Rust prover.

Pinned to **aztec-packages v5.0.0-rc.2**. Node
`https://v5.testnet.rpc.aztec-labs.com`, fees via SponsoredFPC
`0x1969946536f0c09269e2c75e414eef4e21a76e763c5514125208db33d7d944d7`.
Design + milestone history + Codex review log: [PLAN.md](PLAN.md).

## Architecture

```
 RN app (Hermes) — UI, key custody, tx tracking
 │  Prover module ── JNI ── libnoir_prover_jni.so (ClientIVC prove+verify)
 │  SecureKeys module ── Android Keystore AES-256-GCM + SecureRandom
 │  MemoryInfo module ── PSS/RSS instrumentation (memory is first-class)
 │  PxeServer module ── loopback asset server, http://127.0.0.1:38271
 ▼
 WebView (Android System WebView) at the loopback origin (secure context)
   @aztec/wallets EmbeddedWallet + @aztec/pxe client/lazy
     witgen: acvm_js WASM  ·  store: persistent IndexedDB  ·  wallet DB: in-memory
     prover: PrivateKernelProver.createChonkProof -> postMessage -> RN -> JNI
   node.sendTx ── https ──▸ Aztec testnet
```

Key decisions (rationale in PLAN.md):

- **Loopback asset server instead of `file://`** (the rn-spike approach):
  stable secure origin => persistent IndexedDB for the PXE data store,
  `crypto.subtle`/OPFS available, real ES-module + worker loading, no 67 MB
  single-file inlining. Cleartext is permitted ONLY for 127.0.0.1
  (`network_security_config.xml`); the port is fixed because the origin keys
  the persisted state.
- **Keys**: generated with `SecureRandom`, stored only as an AES-256-GCM
  sealed blob whose key lives in the Android Keystore (never exported).
  Unsealed material exists in JS memory for the session. The EmbeddedWallet's
  wallet DB (which persists account secrets) is overridden with a genuinely
  in-memory store (`pxe-web/src/mem-store.ts`) — the kv-store "ephemeral"
  IndexedDB store still writes to disk, which is why it isn't used.
- **Persistence**: the PXE data store (notes, contracts, sync position)
  persists in IndexedDB and survives app restarts; accounts are re-registered
  each boot from the sealed vault (idempotent against the persistent store).
- **Pending txs**: every send uses `wait: NO_WAIT`; the tx hash is persisted
  immediately and a poller drives the v5 `TxStatus` union
  (pending -> proposed/checkpointed/proven/finalized, dropped with a grace
  window, `executionResult` respected — a mined-but-reverted tx is failure).
  Polling resumes across app restarts. Work that dies before a tx hash exists
  is surfaced as failed-before-submit and rebuilt intentionally, never
  blindly resubmitted.
- **AMM setup** is a resumable step machine (deploy LP+AMM -> set_minter ->
  ready); each step advances only after the previous step's tx confirmed
  with execution success.

## What landed on testnet (emulator-originated, on-device proofs)

| Flow | tx | block | native prove |
|---|---|---|---|
| account deploy (ECDSA-R1, class published in-tx) | `0x1972ee…5036d3` | 2773 | 2555 ms |
| token deploy (TestTokenA) | `0x16e036…0cefb2` | 2780 | 1776 ms |
| private mint 1000 TTA | `0x1efbdc…a964a2` | 2781 | 1880 ms |
| private transfer 100 | `0x0f56a7…cbd077` | 2789 | 2498 ms |
| token deploy (TestTokenB) | `0x29c7c3e394a93703f6bcf06f852dcd0c5b6994119d04ed818296a03f34a1d41d` | 2793 | 1908 ms |
| private mint 1000 TTB | `0x277e72ea903f356d0d809e8989228e9670725970008170aecd4d3ef764298522` | 2794 | 2380 ms |
| LP token deploy | `0x03837086a7d36c83319468382596f8b45dc0f5311a8a6ae681931f322c42aeb8` | 2795 | 1852 ms |
| AMM deploy | `0x27d87e9dd6c6b0ef483c28cf8964100dc140f9f8935707523dac9d1dc44e12fb` | 2796 | 2427 ms |
| LP set_minter(AMM) | `0x25080ffcae7ab47a2fe6af9fddb25e3c1ab5810ba5ddf61ab2ce427bc3e55bf7` | 2801 | 1828 ms |
| **AMM add_liquidity (14 circuits, 2 authwits)** | `0x1c840bfa352ee6a366475bb113ba6b29f67ad6d75ef0bf4040b516e952c6d771` | 2803 | 2189 ms |

Explorer: `https://testnet.aztecscan.xyz/tx/<hash>`. All statuses
proposed-or-better with `executionResult: success`. (The first four hashes
are truncated as displayed in-app; full hashes are logged for every
subsequent submit — see the commit history for the session log.)

Also verified on the emulator: Keystore vault restore after force-stop (no
key re-entry), minted balance surviving a kill between mint and transfer
(persistent PXE store), pending-tx polling resuming after restart.

## Timings (measured, x86_64 emulator — arm64 hardware unmeasured)

Per-tx on-device work (WebView witgen + authwits + native ClientIVC prove +
proof reconstruction), from flow start to node submission, release build:

| Flow | tap -> submitted | of which native prove call |
|---|---|---|
| private transfer (7 circuits) | ~11 s | 5.1 s wall (2.5 s prove) |
| account deploy (11 circuits) | ~18 s | 6.5 s wall (2.6 s prove) |
| token deploy / mint (~12 circuits) | ~12–14 s | 4.6–5.4 s wall (1.8–2.4 s) |
| AMM add_liquidity (14 circuits, 2 authwits) | ~23 s | 10.4 s wall (2.2 s prove) |

"Wall" is the whole JNI call (ClientIVC load+accumulate+prove+vk+verify +
JSON marshalling); "prove" is the final Chonk prove step. Testnet inclusion
added ~10–60 s per tx on top (network, not device). PXE boot ~5 s; SRS init
~0.3 s; account restore after the first registration ~0.1 s (first
registration ~25 s, dominated by account-class computation).

## Memory (measured, x86_64 emulator — arm64 hardware unmeasured)

Memory is the known risk (see PLAN.md). Instrumentation: native prover
`peak_rss_mb`, in-app `MemoryInfo` (PSS + VmRSS/VmHWM), host-side
`scripts/mem-watch.sh` (dumpsys, app + WebView renderer processes).

| Measurement | Value |
|---|---|
| App-process peak RSS (VmHWM), account/token/transfer proves | 583–662 MB |
| App-process peak RSS (VmHWM), AMM add-liquidity prove (14 circuits) | **710 MB** |
| App PSS peak (dumpsys, 2 s sampling, whole session) | 462 MB |
| WebView renderer PSS peak | 429 MB |
| Concurrent total PSS peak (app + renderer) | 733 MB |

Gate decision (PLAN.md M3): under the 800 MB app-process / 1.2 GB total
thresholds — the prover-process-isolation mitigation is designed but NOT
implemented; the 14-circuit AMM prove at 710 MB is the closest approach to
the gate. These are emulator numbers; a low-RAM physical arm64 device remains
the open risk and is explicitly unvalidated (no hardware available). If real
hardware shows higher pressure, the documented mitigation (prove in a
killable `:prover` process, payloads over app-private cache files) is the
next step.

## Build & run

Prereqs: repo root prereqs (Rust + cargo-ndk + NDK 27, see root README),
Node >= 22, JDK 17, Android SDK, an emulator or device (API >= 29).

```bash
# 1. Native prover (writes to the root android app's jniLibs; shared here)
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
./scripts/build-jni.sh

# 2. WebView PXE bundle
cd wallet/pxe-web && npm install && npm run build && cd ../..

# 3. Assemble app assets (PXE bundle + SRS + jniLibs; all gitignored)
wallet/scripts/sync-assets.sh

# 4. Build + install the app
cd wallet/app && npm install
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n foundation.aztec.wallet/.MainActivity
```

Debug builds work too (`npm run android` with Metro) — the WebView PXE side
is independent of Metro. `adb logcat -s ReactNativeJS` shows the wallet log;
the in-app Debug tab shows logs, memory, and prove metrics.

Host-side smoke test of the WebView bundle (no emulator needed):
`cd wallet/pxe-web && node scripts/host-smoke.mjs <url-of-dist>` — drives the
same RPC dispatcher in headless Chromium.

## Threat model (honest)

- Spend-authorizing material (ECDSA signing key + account secret/salt) at
  rest: AES-256-GCM sealed, key in Android Keystore (hardware-backed where
  available). Never in git or plaintext storage; nothing logs it by design,
  and errors from key-bearing RPC methods are redacted (no stacks, long hex
  runs stripped) before they can reach the log panel/logcat. No
  biometric/user-auth gating yet (deferred).
- The persistent PXE IndexedDB store contains viewing/nullifier key material
  derived from the account secret — privacy-sensitive (note decryption) but
  not spend-authorizing. Protected by the app sandbox only. Encrypted
  sqlite-opfs stores are a documented stretch (PLAN.md) — OPFS probed
  available in this WebView.
- The loopback server serves only the static public PXE bundle; RPC and key
  material never transit HTTP. Other apps can fetch the bundle (public code).
  Fixed port; bind failure is a hard error, never a silent port change.
- WebView hardening: origin-pinned navigation, no file access, no mixed
  content, content debugging off in release, message shape validation on both
  sides of the bridge.

## Known limitations / deferred

- iOS (released arm64-ios static lib exists; Apple libc++ is std::__1 so no
  workaround needed) — deferred milestone.
- JSI/TurboModule bridge — deferred; measured bridge overhead ~0.3 %.
- Physical arm64 device validation — blocked on hardware; all numbers above
  are x86_64 emulator numbers and labeled as such.
- AMM swap — needs the client-flows harness; out of MVP scope.
- Single account; no biometric unlock; no address book persistence beyond
  registered senders; APK size untrimmed (~168 MB release with 4 RN ABIs +
  70 MB PXE bundle + 37 MB SRS).
- Release builds fall back to the PUBLIC RN debug signing key unless
  `WALLET_RELEASE_STORE_FILE/_PASSWORD/_KEY_ALIAS/_KEY_PASSWORD` are set —
  local/emulator convenience only, never distributable (the build prints a
  warning).
- Restore-at-boot re-registers the account (~30–60 s on the emulator,
  dominated by account contract class recomputation) — optimizable later.
