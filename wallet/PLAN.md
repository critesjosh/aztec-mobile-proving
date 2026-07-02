# Aztec mobile wallet build plan

A React Native Android wallet that runs a full on-device Aztec PXE and proves
transactions natively, built on the proven WebView-hybrid foundation from
`rn-spike/`. Pinned to **aztec-packages v5.0.0-rc.2** against Aztec testnet
(node `https://v5.testnet.rpc.aztec-labs.com`, SponsoredFPC
`0x1969946536f0c09269e2c75e414eef4e21a76e763c5514125208db33d7d944d7`).

This plan is committed before implementation so it is reviewable. A Codex
feedback round is run on it and logged at the bottom before build starts.

## Foundation (proven, do not re-litigate)

From `rn-spike/` (see its README for evidence):

- The v5 PXE cannot run under Hermes (needs `WebAssembly` + `IndexedDB`). It
  runs in an Android WebView; kernel witgen is acvm_js WASM in the WebView.
- The ClientIVC proof is produced on-device by the native Rust prover
  (`libnoir_prover_jni.so` from `crates/noir-prover` + vendored
  barretenberg-rs), injected as the PXE's
  `PrivateKernelProver.createChonkProof` over a WebView -> RN -> JNI bridge.
- Real testnet txs landed from the device this way (account deploy
  `0x077de30b…c110` block 2689; private transfer `0x10cd26a8…e7c6` block 2718).
- Measured on the x86_64 emulator (arm64 device UNMEASURED): WebView witgen
  sub-1 s/tx (scales fine 7 -> 14 circuits), native prove 1.4-2.2 s,
  transfer end-to-end ~3.6 s, AMM add-liquidity ~7.8-8.5 s native total,
  bridge overhead ~0.3 % (JSI/TurboModule deferred), peak RSS ~0.7-0.8 GB
  during native prove (the memory risk).

## Locked decisions

1. Build on the WebView-hybrid. No Hermes port, no architecture pivot.
2. Pin v5.0.0-rc.2 everywhere (npm `@aztec/*`, native libs, testnet params).
3. JSI/TurboModule is a later optimization, not a blocker (bridge is ~0.3 %).
4. Two fail-fast milestones front-loaded:
   - Memory as first-class: instrument and measure peak RSS from the first
     runnable build; if ~0.8 GB threatens low-RAM phones, implement mitigation
     (prover process isolation, below) before building more features on top.
   - Physical arm64 device validation as soon as one is available. None is
     available now: keep measuring the emulator and never claim device perf
     that was not measured.
5. Real key management: Android Keystore + secure RNG replaces the
   `Math.random` throwaway. Keys never leave the device, never committed.
6. MVP scope: account create/deploy, private token transfer, AMM
   add-liquidity (swap needs the client-flows harness; deferred), real
   PXE/account/note persistence, pending-tx/error/recovery handling, a real
   but focused UI. Android-first; iOS later (arm64-ios static lib is released
   and Apple libc++ is std::__1, so no libc++ workaround needed there).
7. Local commits only, author `critesjosh <jc@joshcrites.com>`; the repo is
   public, so no secrets in git ever.

## Layout

```
wallet/
  PLAN.md              this plan (+ Codex feedback log)
  README.md            build/run instructions + honest benchmarks (M8)
  pxe-web/             WebView side: browser PXE + wallet RPC (vite bundle)
    src/wallet-main.ts        RPC dispatcher + flows
    src/native-prover-bridge.ts  (reused from rn-spike, same protocol)
  app/                 RN 0.84 app "AztecWallet" (package foundation.aztec.wallet)
    src/               config, pxe session client, key store, tx store, screens
    android/           ProverModule/SecureKeysModule/MemoryModule + jniLibs + assets
```

`rn-spike/` stays frozen as the spike record. The native crates
(`crates/noir-prover`, `crates/noir-prover-jni`), `scripts/build-jni.sh`, SRS
assets, and the vendored barretenberg-rs are reused as-is; wallet-driven fixes
land as separate commits if needed.

## Architecture

```
 React Native app (Hermes)  — UI, key custody, tx tracking
   │ Prover native module (chonkProve, initSrs)      ── libnoir_prover_jni.so
   │ SecureKeys native module (randomBytes, seal/unseal) ── Android Keystore
   │ Memory native module (sample PSS)               ── Debug.MemoryInfo
   ▼
 WebView (Android System WebView: WASM + IndexedDB [+ OPFS if secure origin])
   @aztec/wallets BrowserEmbeddedWallet (PXE client/lazy)
     witgen: acvm_js WASM   store: persistent   prover: native via bridge
   RPC: RN -> WebView  { type:'rpc', id, method, params }
        WebView -> RN  { type:'rpcResult', id, ok, result|error }
                       { type:'progress', id, phase, data }
                       { type:'proveRequest', id, ivcInputsB64 }   (unchanged)
        RN -> WebView  { type:'proveResult', id, ... }             (unchanged)
   node.sendTx ── RPC ──▸ Aztec testnet
```

### WebView side (`pxe-web`)

Evolves `rn-spike/webview-pxe` from two hardcoded flows into a generic RPC
server over the proven postMessage transport. The prove bridge
(`proveRequest`/`proveResult`, base64 msgpack in, proof fields + vk out) is
byte-identical to the spike; it is the load-bearing path that landed txs and
is not changed.

RPC methods (all long ops emit `progress` events):

- `boot({ nodeUrl, sponsoredFpc, persistent })` — create
  `BrowserEmbeddedWallet` with the native-prover Proxy
  (`proverOrOptions: nativeProver, simulator: WASMSimulator`), register the
  SponsoredFPC contract. `persistent: true` => `ephemeral: false` with an
  in-memory override for the wallet DB (see key management).
- `restoreAccounts({ accounts: [{secret, salt, signingKey, alias}] })` —
  re-register accounts from RN sealed storage into the fresh wallet/PXE
  session (`createECDSARAccount` is deterministic; verify idempotent
  re-registration against a persistent PXE store in M3).
- `deployAccount({ address })` — `getDeployMethod().send({ from: NO_FROM,
  skipClassPublication: false, fee: sponsored })`; returns txHash immediately,
  receipt is polled separately.
- `deployToken({ from, name, symbol, decimals })`, `mintPrivate({ token,
  from, amount })`, `transfer({ token, from, to, amount })`,
  `balanceOfPrivate({ token, owner })` (utility simulate),
  `registerContract({ address, artifactName })`, `registerSender({ address })`.
- AMM: `deployAmm({ from, token0, token1 })` (deploys liquidity token + AMM +
  `set_minter(amm, true)`), `addLiquidity({ amm, token0, token1, from,
  amount0, amount1 })` — two authwits for
  `transfer_to_public_and_prepare_private_balance_increase` with
  `caller: amm`, then `add_liquidity(...).with({ authWitnesses }).send()`,
  exactly the client-flows/e2e_amm pattern.
- `getTxReceipt({ txHash })`, `getBlockNumber()`, `getAccounts()`.

Send-type methods return `{ txHash }` as soon as the tx is submitted (they do
NOT wait for mining); RN tracks status by polling `getTxReceipt`. This is what
makes pending-tx recovery possible across app restarts.

### RN side (`app`)

- `src/pxe/PxeSession.ts` — typed RPC client over the WebView: request queue,
  per-call timeouts, progress event stream, `proveRequest` handling (calls the
  Prover module, posts `proveResult` back — same code path as the spike, plus
  payload validation), WebView crash detection
  (`onRenderProcessGone`/`onContentProcessDidTerminate` -> session restart +
  surfaced error).
- `src/keys/keyStore.ts` — account material custody (below).
- `src/txs/pendingTxStore.ts` — persisted pending/settled tx list
  (AsyncStorage): `{ txHash, kind, meta, createdAt, status, lastError }`;
  poller drives pending -> proposed/checkpointed/finalized or failed/dropped
  (`dropped` = not found after a timeout window); resumes polling on app
  restart; UI shows retry affordances where retry is safe (idempotent
  deploys are NOT blindly retried; a fresh tx is built instead).
- `src/tokens/tokenStore.ts` — registered token/AMM addresses + metadata
  (AsyncStorage; addresses are public data).
- Screens (lightweight state-based navigation, no react-navigation dep):
  - Onboarding: generate keys (secure RNG) -> create account -> deploy
    (sponsored) with progress.
  - Home: account address (copy), token list with private balances, refresh.
  - Send: token, recipient, amount -> private transfer; sender registration
    UX for receiving.
  - AMM: guided setup (deploy token0/token1 if needed -> deploy AMM ->
    mint -> add liquidity), resumable step machine persisted per step.
  - Activity: tx list from pendingTxStore with status chips + explorer links.
  - Debug drawer: log panel, memory readout, SRS/PXE status, reset app data.
- `src/config.ts` — NODE_URL, SPONSORED_FPC, explorer base. Public constants,
  committed. No `.env` needed on device; `.gitignore` already covers `.env`.

### Key management (Android Keystore + secure RNG)

Aztec ECDSA-R accounts need three secrets usable inside the PXE JS: the
account `secret` (Fr), `salt` (Fr), and the ECDSA P-256 `signingKey`
(32 bytes). Signing happens in JS/circuits, so the raw key must be available
to the WebView session in memory; Keystore-non-extractable signing is not
possible for this curve usage. The standard Android pattern applies:

- `SecureKeysModule.randomBytes(n)` — `java.security.SecureRandom` (fixes the
  `Math.random` throwaway).
- `SecureKeysModule.seal(b64)` / `unseal(b64)` — AES-256-GCM key generated in
  and never leaving the **AndroidKeyStore** (hardware-backed where available);
  the sealed blob (IV + ciphertext) is stored in app-private storage.
- `keyStore.ts` keeps the account file `{ version, accounts: [{ alias, type,
  secret, salt, signingKey, address, deployTxHash }] }` ONLY as a sealed blob;
  unsealed content lives in JS memory for the session and is passed to the
  WebView `restoreAccounts` at boot.
- Threat model documented in README: sealed-at-rest spend keys (Keystore);
  the persistent PXE store (IndexedDB, app sandbox) holds viewing/nullifier
  key material derived from `secret` — privacy-sensitive but not
  spend-authorizing without the ECDSA key. Stretch (feature-flagged, only if
  the secure-origin check passes): v5 `@aztec/wallets/embedded/store-encryption`
  + `@aztec/kv-store/sqlite-opfs` encrypted stores with the 32-byte store key
  sealed via Keystore — requires OPFS, i.e. a secure origin.
- Nothing key-like is ever written to logs, git, or the log panel.

### Persistence

- PXE data store: `ephemeral: false` gives IndexedDB-backed PXE state
  (`pxe_data_<rollupAddress>`) — notes, contracts, sync position survive app
  restarts (no re-scan, no re-registration of contract artifacts).
- Wallet DB: `BrowserEmbeddedWallet` would persist account secret keys
  plaintext in IndexedDB. We override `walletDb.store` with an in-memory
  store and instead restore accounts each boot from RN sealed storage, so
  spend keys at rest exist only Keystore-sealed.
- FAIL-FAST check (M2): verify IndexedDB actually persists across app
  restarts for our WebView origin. The spike ran `file://` +
  `ephemeral: true`, so persistence is unverified. Plan A is a ~100-line
  loopback HTTP asset server (Kotlin, fixed port, 127.0.0.1 only) serving the
  vite dist: `http://127.0.0.1:<port>` is a secure context (stable origin =>
  reliable IndexedDB persistence, OPFS/`crypto.subtle` available, and the
  67 MB single-file inlining becomes unnecessary). Plan B (fallback) is the
  proven `file:///android_asset` single-file bundle, with persistence
  re-verified there. Loopback server caveats documented: fixed port for
  origin stability; serves only static public assets (no secrets, RPC stays
  on postMessage); other apps on the device can fetch the static bundle,
  which is public code.

### Memory (first-class, fail-fast)

- Instrumentation from the first runnable build:
  - native prover already reports `peak_rss_mb` per prove;
  - `MemoryModule.sample()` — `Debug.MemoryInfo` totalPss of the app process,
    shown in the debug drawer and logged around each prove;
  - `scripts/mem-watch.sh` — host-side sampler of
    `adb shell dumpsys meminfo` for the app package + WebView sandboxed
    process during flows; records peak PSS per flow.
- Gate at M3 (first in-wallet prove): if app-process peak exceeds ~800 MB or
  app+WebView total exceeds ~1.2 GB on the emulator, implement mitigation
  BEFORE M4+ features:
  - Prover process isolation: move `chonkProve` into a bound service in a
    separate `:prover` process. Payloads cross via files in `cacheDir` (Binder
    caps transactions ~1 MB; the ivc msgpack is multi-MB), path over AIDL/
    Messenger. After each prove the service process can be killed, returning
    its ~0.7-0.8 GB peak to the OS; cost is SRS re-init (~0.5-1 s) per prove.
    This also stops the prover peak from counting against the app process at
    all — the most effective lever we have without touching barretenberg.
- Report peak RSS per flow in README benchmarks either way. Emulator numbers
  are labeled emulator numbers.

### Pending tx / error / recovery

- Every send returns txHash pre-mining; pendingTxStore persists immediately.
- Poller (foreground, 5 s interval while pending txs exist) drives status;
  app restart resumes polling from the persisted store.
- Failure surfaces: witgen/simulation errors (shown with message, safe to
  rebuild tx), native prove failure (logged, tx never submitted, safe retry),
  submit/network errors (retry submit if the tx object still exists in
  session, else rebuild), dropped-from-mempool detection via timeout.
- WebView render-process death: PxeSession rejects all in-flight RPCs,
  reboots the session (re-`boot` + `restoreAccounts`), UI shows a recoverable
  error state. In-flight txs stay "pending" and resolve via receipt polling
  where they were already submitted.
- SRS init failure / node unreachable at boot: blocking error screen with
  retry, not a crash.

## Milestones

Each milestone ends with: emulator verification, a Codex review
(`codex exec` review prompt over the diff), findings verified against source
and accepted/rejected with reasons, then a local commit.

- **M0 — Plan.** This document, committed first. Codex round on the plan;
  feedback log appended below.
- **M1 — Scaffold + boot + memory instrumentation.** `wallet/pxe-web` (RPC
  dispatcher, boot only) + `wallet/app` (RN 0.84, Prover/SecureKeys/Memory
  modules, PxeSession, debug drawer). Asset serving decision (loopback server
  vs file://) made here with the persistence fail-fast check. Exit: PXE boots
  in the wallet app on the emulator, SRS inits, memory sampling works,
  IndexedDB persistence across restart VERIFIED.
- **M2 — Keys + onboarding + account deploy.** SecureKeys sealing, keyStore,
  onboarding flow. Exit: account created with secure RNG, sealed at rest,
  deployed on testnet from the emulator (real tx hash), restart restores the
  account without re-entry.
- **M3 — First-prove memory gate.** Measure peak RSS around the M2 deploy
  prove (app + WebView processes). Decide and, if triggered, implement
  prover process isolation and re-measure. Exit: recorded numbers + decision
  in README; foundation declared safe to build on (or mitigation landed).
- **M4 — Persistence + tokens + transfer.** Persistent PXE store in anger:
  deploy token, mint private, balances, private transfer to another address,
  sender registration. Exit: transfer tx lands from the emulator; balances
  and notes survive app restart (kill app between mint and transfer).
- **M5 — Pending-tx/error/recovery hardening.** pendingTxStore + poller +
  WebView-crash recovery + failure-path UX. Exit: kill-app-mid-flow and
  airplane-mode tests behave as designed.
- **M6 — AMM add-liquidity.** Guided resumable AMM setup + add_liquidity with
  the two authwits. Exit: add-liquidity tx lands on testnet from the
  emulator (real tx hash); witgen/prove/memory measured for the 14-circuit
  flow inside the wallet.
- **M7 — UI/UX pass.** Focused polish of the five screens, empty/error/busy
  states, copy. No gold-plating.
- **M8 — Docs + final review.** wallet/README.md (build, run, architecture,
  honest benchmarks incl. peak memory, threat model, deferred list), final
  Codex review across the wallet, final commit.

## Explicitly deferred

- iOS (Swift ProverModule + arm64-ios static lib; no libc++ workaround
  needed). JSI/TurboModule bridge. Physical arm64 device validation
  (blocked on hardware availability — emulator numbers are labeled as such).
  AMM swap (needs the client-flows harness to be proven first). Biometric
  unlock / user-auth-gated Keystore. Multithreaded WebView witgen.
  Encrypted sqlite-opfs stores if the secure-origin check fails cheaply.
  Bundle-size trim beyond what the loopback server gives for free.

## Risks

- **Peak memory on low-RAM phones** — the known risk; mitigations planned and
  gated at M3. If even process isolation leaves the device short (cannot be
  proven without hardware), that is surfaced honestly, not papered over.
- **IndexedDB persistence over the chosen origin** — fail-fast check at M1;
  two viable serving strategies.
- **Idempotent account re-registration** against a persistent PXE store —
  verified at M2; fallback is explicit "already registered" handling around
  `createECDSARAccount`/PXE `registerAccount`.
- **Testnet variance** (inclusion delays, node hiccups) — send-then-poll
  design absorbs this; benchmarks separate local phases from network phases.
- **AMM flow length** (~6-8 txs on testnet) — resumable step machine;
  each step is small and individually retryable.

## Codex feedback log

- Round 1 (on this plan): pending — run before M1 starts; findings and
  accept/reject rationale will be recorded here.
