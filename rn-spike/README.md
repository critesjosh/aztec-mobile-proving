# React Native on-device PXE spike

Goal: a minimal RN app that runs the Aztec PXE on-device, wires this repo's
native prover in as the ClientIVC prover, and lands one real testnet tx from the
device. Pinned to v5.0.0-rc.2 + verified v5 testnet params
(`v5.testnet.rpc.aztec-labs.com`, SponsoredFPC `0x1969…944d7`).

This is a **spike**: the point is to find where it fights back and report
honestly, before any full wallet build.

## The core constraint (measured, not assumed)

The Aztec PXE is designed to run **in a browser as WASM**. The v5.0.0-rc.2
browser entrypoint `@aztec/pxe/client/lazy` (`createPXE`) composes three
hard browser dependencies:

| PXE piece | Package | Needs |
|---|---|---|
| kernel-circuit witness gen | `@aztec/simulator` `WASMSimulator` → `@aztec/noir-acvm_js` (web build) | `WebAssembly.instantiate` on a ~3 MB wasm-bindgen module |
| ClientIVC proving | `@aztec/bb-prover/client/lazy` → bb.js | barretenberg WASM (or a native prover) |
| note/state store | `@aztec/kv-store/indexeddb` | `IndexedDB` |

React Native's JS engine is **Hermes**. Hermes has **no built-in
`WebAssembly`** and **no `IndexedDB`**. (RN 0.84 / Hermes V1 blog chatter about
"WebAssembly landing" is third-party; the official RN 0.84 release notes do not
document a usable `WebAssembly` global. The available polyfills —
`react-native-webassembly` (wasm3 interpreter, single-memory limit, active-dev),
`inokawa/react-native-wasm` — are not viable for a 3 MB wasm-bindgen module with
hundreds of JS imports, and have open Hermes-JSI binding issues.)

**Therefore, `@aztec/pxe` cannot boot in Hermes as-is.** This matches the state
of the art: the closest prior art, `porco-rosso-j/aztec-mobile-wallet-dry`,
explicitly does **not** run the PXE or proving on-device — it bridges ~10 bb
primitives natively and states running the PXE + proving natively "requires many
more methods, esp. acir-related functions." Nobody runs the full v5 PXE in
Hermes today.

## Architecture chosen for the spike

Host the **browser PXE inside a `react-native-webview`** (which has real
`WebAssembly` + `IndexedDB`), and inject **this repo's native prover** as the
PXE's `PrivateKernelProver.createChonkProof` — the *same* injection the
`testnet/` harness already proved works, except the proving call now crosses
WebView → RN → native. Kernel witgen (acvm_js) stays in the WebView's WASM;
the ClientIVC proof (the expensive part) is produced by the native Rust prover
on the device.

```
 React Native app (Hermes)
   │  RN native module (JSI/TurboModule) ── noir-prover Rust lib (this repo)
   │        ▲  proveChonk(ivcInputsMsgpack) -> {proofFields, vk}
   │        │  (same ProverBridge contract as testnet/src/bridge)
   ▼        │
 WebView (has WebAssembly + IndexedDB)
   @aztec/pxe client/lazy  ── witgen (acvm_js WASM) + tx assembly
        │  createChonkProof(executionSteps)  ─ postMessage ─▸ RN native module
        │  ◀── proofFields+vk ── ChonkProofWithPublicInputs.fromBufferArray
        ▼
   node.sendTx  ─RPC─▸  Aztec testnet (v5.testnet.rpc.aztec-labs.com)
```

This is a hybrid, and honestly labeled: witgen runs in the WebView's WASM (still
on-device, just not in Hermes); the ClientIVC proof runs in native Rust (also
on-device). A pure-Hermes PXE is blocked until Hermes ships production
`WebAssembly` (or acvm/kernel-sim is compiled to a native module — the "many
more acir methods" the dry wallet flagged; tracked as future work).

### Why WebView, not a Hermes port (state of the art)

Prior art (researched, v5.0.0-rc.2 era):
- **`porco-rosso-j/aztec-mobile-wallet-dry`** runs aztec.js *client JS* in Hermes
  but connects to a **remote PXE over HTTP** and offloads crypto to a native
  Swift/Rust bb build (`react-native-bb.js` replacing `@aztec/bb.js`). Getting
  aztec.js to load at all required: Metro `unstable_enablePackageExports`,
  `node-libs-react-native`, buffer/process/crypto/stream/url polyfills, stubbing
  `worker_threads`/`fs`/`net`/`tls` to empty (so **no worker threads**), faking
  `process.version`, and a Babel transform rewriting `import.meta` → `undefined`.
  The **real crux**: bb.js is **synchronous**, RN native modules are **async**,
  so they had to fork the *entire* Aztec JS package graph into async variants
  (`yarn-project-async`, nine `@aztec/*` `file:`-overrides). Proving on-device is
  **not implemented** — all `acir*`/`srs*` bb methods are `throw "not
  supported"` stubs, and there is no acvm_js in the stack at all.
- **`madztheo/noir-react-native-starter`** proves on-device but **bypasses PXE
  and aztec.js entirely** — old-arch native module (`NativeModules.NoirModule`,
  not JSI) driving barretenberg (Swoirenberg / noir_android / noir_rs) for plain
  Noir circuits. Witgen + prove + verify all native; JS only marshals hex
  strings. No `@aztec/*` deps.

Neither runs the full v5 PXE with WASM in Hermes; neither uses a WebView. The
WebView approach here sidesteps the two things that stalled the Hermes port:
(1) no `WebAssembly`/`IndexedDB` in Hermes — the WebView has both; (2) the
sync/async bb.js wall — inside the WebView, bb.js runs exactly as it does in a
browser (its own WASM), so **no fork of the Aztec JS graph is needed**; only the
ClientIVC `createChonkProof` is redirected to the native prover, which is
already an async boundary in the `PrivateKernelProver` interface.

## Status / build log (honest)

### 1. Does the PXE boot? YES — in a browser/WebView environment.

The v5.0.0-rc.2 browser PXE boots end-to-end in ~5 s in headless Chromium
(the WebView engine family), driving the real testnet. Captured sequence
(`webview-pxe`, Playwright over the Vite bundle):

```
status boot:start (node v5.testnet.rpc.aztec-labs.com)
status node:ready
status wasm:acvm-init          ← acvm_js WASM instantiated
pxe:data:idb Creating pxe_data ephemeral data store   ← IndexedDB store
pxe:service Added contract MultiCallEntrypoint / AuthRegistry / HandshakeRegistry
pxe:service Started PXE connected to chain 11155111 version 2787991301
status pxe:ready
pxe:service Added contract SponsoredFPC at 0x1969…944d7
status boot:done
```

Notably, `createPXE(node, config, { proverOrOptions: nativeProver, simulator })`
**accepted our native-prover wrapper** (a Proxy over `BBLazyPrivateKernelProver`
that redirects only `createChonkProof` to the RN bridge). So the PXE runs its
acvm_js kernel witgen in WASM and will call OUT to native for the ClientIVC
proof. This is the design working as intended.

### 2. Does it boot under Hermes (no WebView)? NO — and won't without WASM.

Confirmed by construction: the boot needs `WebAssembly` (acvm_js) + `IndexedDB`
(kv-store) + browser globals, none of which Hermes provides reliably. The
WebView provides all three. This is why the spike uses a WebView, not a Hermes
port (see prior-art analysis above).

### 3. Full round-trip (WebView PXE + native prover): a real testnet tx LANDED

Driving the `webview-pxe` bundle in headless Chromium (WebView engine family)
with the native prover reached over a bridge, an ecdsa_r1 **account deployment
landed on testnet**, ClientIVC proof produced by the native Rust prover:

- tx `0x1128e975965241208fd170e51eb15786288b7d4589576c0501336f61178563e0`
- on-chain: **status proposed, block 2672**
- flow: WebView PXE boot → acvm_js WASM witgen (10 circuits) →
  `proveRequest` out to native `bb-chonk-prove` (verified=true, 1,115 ms,
  2,630 proof fields) → `proveResult` back → PXE reconstructs
  `ChonkProofWithPublicInputs` → `node.sendTx` → mined.

This is the novel result: **no public precedent runs the full v5 PXE with a
native ClientIVC prover to land a real tx.** The architecture is proven.

In this run the WebView engine was desktop Chromium and the native prover was
reached via a Node child-process bridge (the same `bb-chonk-prove` binary the
`testnet/` harness uses). Swapping desktop-Chromium→Android-WebView and
Node-bridge→JSI-native-module is the remaining engineering (both are
well-trodden RN mechanisms; the risky/unknown parts — WASM PXE boot, native
prover injection, proof reconstruction, on-chain acceptance — are all proven).

### 4. Device-originated tx (Android emulator): LANDED

The full RN app (`AztecPxeSpike/`, RN 0.84, New Arch/Hermes) ran on the Android
emulator (x86_64, API 36) and sent a real testnet tx end-to-end from the device:

- tx `0x077de30beecf337ac9ecbf4da41990897ebb58484cbd99d3a912019616d8c110`
- on-chain: **status checkpointed, block 2689**

On-device flow (from the app's own log view + logcat):
```
WebView ready
SRS init: {"grumpkin_points":65536,"num_points":524288,"ok":true}   ← native libnoir_prover_jni.so
status: wasm:acvm-init                                              ← WebView acvm_js WASM
Started PXE connected to chain 11155111 version 2787991301          ← Android System WebView
status: account 0x1eb4c9…
Private kernel witness generation took 1219 ms                      ← witgen in WebView WASM
proveRequest #1 -> native prover (on-device)
native prove: verified=true prove=2032ms fields=2630 wall=4759ms    ← native Rust prover, on device
Sent transaction 0x077de30b…
TX proposed
```

So: the PXE runs in the Android System WebView (Chromium 134) doing acvm_js WASM
kernel witgen + IndexedDB; the ClientIVC proof is produced ON THE DEVICE by the
native Rust `libnoir_prover_jni.so` (Kotlin `ProverModule` bridging the WebView
`proveRequest` → JNI `chonkProve`); the proof is reconstructed as
`ChonkProofWithPublicInputs` in the WebView and submitted to testnet.

Native prove on the emulator was ~2.0 s (vs ~1.1–1.3 s on host — emulator is
slower; a real arm64 device would differ again). App proving-relevant peak was
comparable to the standalone app benchmarks.

### 5. Heavier-flow measurement pass (7 → 14 circuits)

All numbers are **x86_64 emulator (API 36)**; a physical arm64 device is
unmeasured and remains the open perf risk (see caveats).

**A. Real on-device transfer flow** (deploy account → deploy token → mint →
private transfer, all through the WebView-PXE + native-prover path). Per-tx,
the WebView single-threaded WASM **witgen** vs the native ClientIVC **prove**:

| tx | circuits | WebView witgen (WASM) | native prove | proof fields |
|---|---|---|---|---|
| account deploy | 11 | 777 ms | 2082 ms | 2630 |
| token deploy | ~12 | 847 ms | 1735 ms | 4133 |
| mint (private) | ~12 | 957 ms | 1416 ms | 4133 |
| **private transfer** | **7** | **695 ms** | **1473 ms** | 2630 |

The transfer landed on testnet:
`0x10cd26a8df0991e104976f042a027ea2ca16afc1342e49bb77da1d9499bfe7c6`
(proposed, block 2718) — a second device-originated tx type.

**B. Native prove + bridge cost for the two target stacks** (bundled realistic
witness stacks proven via the native module, 2 runs each — isolates prove +
the output-bridge marshalling, no WebView):

| stack | circuits | native prove | vk | verify | load+accum | native total | peak RSS | proof fields | result JSON | bridge xfer | JSON.parse |
|---|---|---|---|---|---|---|---|---|---|---|---|
| token_transfer | 7 | 1432–1473 ms | 182–270 ms | 31–73 ms | ~1.8 s | 3.60–3.64 s | 713–814 MB | 2630 | 0.19 MB | 8–24 ms | 0–1 ms |
| amm_add_liquidity | 14 | 1917–2220 ms | 192–205 ms | 33–34 ms | ~5.4 s | 7.76–8.52 s | 814 MB | 4133 | 0.29 MB | 8–14 ms | 0–3 ms |

(Host x86_64 baseline: transfer total 2.42 s / 320 MB; AMM total 4.46 s / 390 MB.)

**Reads on the three questions:**

1. **Does single-threaded WebView witgen scale 7 → 14?** Yes, comfortably. Witgen
   stayed **sub-1 second per tx** across the whole transfer flow (695–957 ms) and
   is *not* the bottleneck — native prove (1.4–2.2 s) dominates. Witgen cost
   tracks per-tx circuit complexity, not a runaway with stack depth, because the
   WASM simulator runs each circuit's ACVM once. AMM (14) witgen wasn't measured
   end-to-end (needs an AMM+2-token+liquidity setup, disproportionate for a
   measurement pass), but the flat sub-1s trend across the 7–12 circuit txs
   strongly suggests 14 stays in the low seconds, not a cliff.

2. **The load+accumulate phase is where circuit count actually bites**: native
   total grew 3.6 s → 7.8 s (7 → 14) driven almost entirely by ClientIVC
   load+accumulate (~1.8 s → ~5.4 s), while the final `prove` grew only
   1.4 → 2.0 s. So heavier txs are gated by **native accumulation**, on the
   native prover, not by WebView witgen. That's the scaling axis to watch.

3. **Bridge overhead is negligible** — marshalling the 2630/4133-field proof +
   VK as JSON across WebView→RN→JNI and back cost **8–24 ms transfer + ≤3 ms
   JSON.parse** for a 0.19–0.29 MB payload. A JSI/TurboModule rewrite is a
   **later optimization, not a must-have**; the bridge is ~0.3% of end-to-end.

**Memory**: native prove peak RSS rose to **~0.7–0.8 GB on-device** (higher than
the ~0.3–0.4 GB host figure — emulator/ART overhead + the WebView process
alongside). This is the number most likely to bite a low-RAM physical device: a
14-circuit AMM at ~0.8 GB plus a Chromium WebView plus RN/Hermes could pressure
a 2–3 GB phone. Worth validating on real hardware before committing to a wallet.

**Viability read**: the WebView-hybrid is a **viable foundation** for a full
wallet on this evidence — witgen scales fine, the bridge is cheap, and heavier
txs are limited by the native prover (which we already own and can optimize),
not by the WebView or the bridge. The one thing that argues for caution (not
rearchitecting) is **peak memory on real low-RAM devices** and the fact that all
numbers are emulator-only. No result here argues for abandoning the WebView
approach before the wallet.

### What fought back (honest build log)

1. **Hermes cannot boot the PXE** — no `WebAssembly`/`IndexedDB`. Resolved by
   the WebView (has both). This is fundamental, not a workaround gap.
2. **`file://` + ES-module + absolute asset paths** — vite's default bundle
   used `src="/assets/…"` and `type="module" crossorigin`, which the Android
   WebView resolved to the device root and refused to run
   (`window.__aztecOnHostMessage is not a function`). Fixed with
   `base: './'` + `vite-plugin-singlefile` (inline the JS into index.html, WASM
   as data URIs) + `allowFileAccessFromFileURLs`/`allowUniversalAccessFromFileURLs`
   on the WebView. This is the classic RN-WebView-over-file:// trap.
3. **playwright/chromium version skew** on the host de-risk harness (cosmetic;
   fixed by pinning playwright-core to the cached chromium build).
4. **sync-vs-async bb.js crux (the thing that stalls Hermes ports) is avoided
   entirely** by the WebView: bb.js runs unmodified in the WebView as in a
   browser; only the async `createChonkProof` is redirected, and that method is
   already async in the interface. No fork of the Aztec JS graph.

### Known limitations / next steps

- **WebView proving offload uses SharedArrayBuffer avoidance**: bb.js WASM
  proving (which needs COOP/COEP-isolated SharedArrayBuffer, unavailable over
  file://) is offloaded to native, so only single-threaded acvm_js witgen runs
  in the WebView. That's the design, but it means kernel witgen is
  single-threaded in the WebView.
- **JSI/TurboModule vs old-arch module**: the native bridge here is a classic
  `ReactContextBaseJavaModule` (works under RN 0.84 New Arch interop). A true
  JSI/TurboModule would avoid the JSON/base64 marshalling of the ~2630-field
  proof across the bridge (a perf/latency refinement, not a blocker).
- **iOS not built** (would need a Swift `ProverModule` + the `arm64-ios`
  static lib; Apple libc++ is `std::__1` so no libc++ workaround needed).
- **Physical arm64 device** not benchmarked.
- **Key storage**: the spike generates a throwaway key on-device per run; a real
  wallet needs Keychain/Keystore-backed secure storage.
- **bundle size**: the inlined WebView bundle is ~67 MB (WASM as data URIs);
  a local http-server-in-app or asset streaming would shrink the APK.
