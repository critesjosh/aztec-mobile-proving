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

### 4. Device-originated tx (Android emulator)

See `AztecPxeSpike/` (RN 0.84 app: Android WebView loading the `webview-pxe`
bundle + a native module bridging `proveRequest` to the on-device Rust prover)
and the parent README RN section for the current state and whether a
device-originated tx landed.
