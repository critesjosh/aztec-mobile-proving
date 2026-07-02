# Testnet harness (hybrid: PXE witgen + native mobile prover)

A Node reference implementation that sends **real Aztec testnet transactions**
whose ClientIVC ("Chonk") proof is produced by THIS REPO'S native prover
(barretenberg-rs FFI), not the bb.js WASM. It is also the **reference the
planned React-Native wallet will mirror** (see "RN punch-list").

## Why a hybrid

The on-device Android app in this repo proves precomputed witness stacks; it has
no PXE/witgen/networking. Sending a real tx needs a PXE (witness generation for
the account + app + kernel circuits) plus node submission and fees — all of
which live in aztec.js/TS. So this harness runs the TS PXE for witgen and tx
assembly, and **injects a custom `PrivateKernelProver`** whose `createChonkProof`
routes the final ClientIVC proof to our native Rust prover. The proof that would
land on-chain is produced by the same native code the phone runs.

## Where proving runs

`BRIDGE=host` proves with the native lib on this machine (fallback); `BRIDGE=adb`
pushes the step stack to an Android device/emulator, proves on-device with a
pushed `bb-chonk-prove` binary, and pulls the proof back — so the on-chain proof
is phone-produced. Both use the identical Rust `noir-prover`.

## Architecture

```
 aztec.js EmbeddedWallet + PXE (WASM simulator)   ── witgen for every circuit
        │  PrivateKernelProver.createChonkProof(executionSteps)
        ▼
 NativeChonkPrivateKernelProver (src/native-prover.ts)   ── portable, RN-reusable
        │  serializePrivateExecutionSteps(steps)  (msgpack)
        ▼
 ProverBridge  ── host child-process | adb-to-device | (future) RN native module
        │  -> bb-chonk-prove (crates/prover-cli) -> noir-prover -> bbapi FFI
        ▼
 flat proof fields + vk  ── ChonkProofWithPublicInputs.fromBufferArray(fields)
        │  (fields order == bb.js flattenChonkProofFields; validated round-trip)
        ▼
 PXE assembles Tx  ->  node.sendTx  ->  mined on testnet
```

## Setup

```bash
cd testnet
npm install
cp .env.example .env      # fill in a fresh throwaway account key (env only!)

# Build the native prover CLI (host) once, from repo root:
#   BB_LIB_DIR=<v5 static libs> cargo build --release -p prover-cli
# For BRIDGE=adb, cross-compile bb-chonk-prove for the device and push it +
# the SRS assets to $DEVICE_PROVER_DIR (see repo README build-jni recipe;
# same RUSTFLAGS/zig-libcxx, target -p prover-cli).
```

`.env` (gitignored) holds the account signing key. NEVER commit it.

## Run

```bash
BRIDGE=host npm run deploy-account   # deploy an ecdsa_r1 account (sponsored FPC fees)
BRIDGE=host npm run transfer         # deploy token, mint, private transfer

BRIDGE=adb  npm run deploy-account   # prove on the phone via adb
```

Each script prints the tx hash, an aztecscan explorer link, the native-proof
metrics (verified/prove-ms/peak-RSS), and a phase-by-phase benchmark.

## Portability / RN punch-list

Portable as-is (works unchanged in React Native): `src/native-prover.ts` (the
`PrivateKernelProver` wrapper + `ProverBridge` interface), `src/testnet.ts`
(connection, sponsored-FPC setup, prover injection), the tx flows, and `bench.ts`.

Node-specific bits the RN wallet must replace:
- **Prover bridge** (`src/bridge/host.ts`, `src/bridge/adb.ts`): both use
  `node:child_process`/`node:fs`. In RN, replace with a JSI/TurboModule that
  calls the same `noir-prover` Rust lib in-process (no child process, no adb).
  The `ProverBridge` contract (bytes in → {proofFields, vk} out) is unchanged.
- **PXE store backend**: `NodeEmbeddedWallet` uses `@aztec/kv-store/lmdb-v2`
  (native LMDB). RN needs an `AztecAsyncKVStore` over an RN storage engine
  (e.g. op-sqlite / MMKV / AsyncStorage), or the in-memory store for ephemeral.
- **WASM→native**: the kernel *simulation* still runs on `@aztec/simulator`'s
  acvm_js WASM here; on RN that WASM must load in the JS engine (Hermes) OR be
  replaced by our native ACVM (the `ultrahonk` feature already links ACVM). The
  bb.js WASM used for the ClientIVC step is what we replace with the native
  module; kernel-sim WASM replacement is a separate follow-on.
- **Worker/threads & filesystem**: bb.js/PXE spin worker threads and read the
  bundled WASM from disk; RN needs the Metro-bundled asset + Hermes-compatible
  worker shims (this is the crux the prior-art RN spike stalled on — our native
  module removes the bb.js proving WASM from that equation).
- **`dotenv`/`process.env`**: replace with RN config/secure-storage for keys.
