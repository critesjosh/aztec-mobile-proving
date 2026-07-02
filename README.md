# aztec-mobile-proving

Native on-device zero-knowledge proving for Android, using Aztec's Barretenberg.
Generate **and verify** real Aztec client-side proofs (ClientIVC / "Chonk") for
full transactions, and standalone UltraHonk proofs, entirely on the device.

Pinned to **aztec-packages v5.0.0-rc.2** (Barretenberg 5.0.0-rc.2, Noir
v1.0.0-beta.22). This repo is self-contained: it clones and builds a working
native-proving Android app **without any aztec-packages source tree**.

## What it does

The bundled app proves + verifies these on-device (all VERIFIED true):

| Flow | Proof system | Circuits | Inputs |
|---|---|---|---|
| Account deployment (ecdsa_r1 + sponsored FPC) | ClientIVC | 10 | bundled `ivc-inputs.msgpack` |
| Private token transfer | ClientIVC | 7 | bundled |
| AMM add liquidity | ClientIVC | 14 | bundled |
| hash_chain512 (poseidon2, 37k gates) | UltraHonk | 1 | on-device ACVM witgen |

The transaction **witness stacks** (`ivc-inputs.msgpack`) are produced
off-device by PXE simulation (that is the Aztec client's job; here we bundle
fixtures captured from the aztec-packages `client_flows` benchmark). All
**proving, verification-key derivation, and verification run on-device**. The
UltraHonk flow additionally runs **ACVM witness generation on-device** from a
compiled Noir circuit + JSON inputs.

## Benchmarks

Android emulator (x86_64, API 36, 8 cores, 12 GB RAM). Times in ms; "total"
covers accumulating every circuit + Chonk prove + hiding-kernel VK + on-device
verify. Peak RSS is the whole app process (ART + native + assets).

| Flow | circuits | total | chonk prove | verify | peak RSS | proof |
|---|---|---|---|---|---|---|
| Token transfer | 7 | 3,764 | 1,442 | 29 | 463 MB | 82 KB |
| Account deploy | 10 | 4,920 | 2,083 | 30 | 466 MB | 82 KB |
| AMM add liquidity | 14 | 8,192 | 2,168 | 34 | 565 MB | 129 KB |
| hash_chain512 (UltraHonk) | 1 | ~620 | 423 | 3 | 565 MB | 458 fields |

SRS init (BN254 2^19 + Grumpkin 2^16, incl. asset read): ~550 ms once at startup.
No physical arm64 device was benchmarked; the arm64-v8a `.so` builds and links
cleanly. Binary sizes: stripped `.so` 18.6 MB (arm64-v8a) / 22.7 MB (x86_64);
debug APK ~89 MB (37 MB SRS + 7.7 MB flow inputs + both `.so`).

## Architecture

```
                     OFF-DEVICE (bundled as assets)
  PXE tx simulation  -> ivc-inputs.msgpack  (one per tx flow)
  nargo (Noir)       -> compiled circuit .json  (UltraHonk demo)
  public Aztec CRS   -> SRS slices (bn254 2^19, grumpkin 2^16)
                                   |
─────────────────────────────────┼───────────────────────────────────────────
                     ON-DEVICE    v
  Kotlin MainActivity ── JNI ──> libnoir_prover_jni.so
                                   |
                                   v
                          noir-prover (Rust)
              ┌────────────────────┴─────────────────────┐
              v (feature "ultrahonk", optional)           v (core)
     ACVM witgen (noir git crates)          barretenberg-rs FfiBackend
     + UltraHonk prove/verify                  (vendored, patched)
                                                  |  msgpack Command/Response
                                                  v
                                          bbapi(...) C entrypoint
                                          libbb-external.a (v5.0.0-rc.2,
                                          downloaded by build.rs)
                                          UltraHonk · ClientIVC · SRS store
```

- **ClientIVC (core)**: parse `ivc-inputs.msgpack` (msgpack array of
  `{bytecode, witness, vk, functionName}`, bytecode/witness gzipped) ->
  `ChonkStart` -> per circuit `ChonkLoad` + `ChonkAccumulate` -> `ChonkProve`
  -> `ChonkComputeVk` (hiding-kernel bytecode, ZK flavor) -> `ChonkVerify`.
- **UltraHonk (optional)**: gunzip nargo ACIR -> `noirc_abi` encodes JSON inputs
  -> ACVM solves the witness -> `CircuitComputeVk` + `CircuitProve` ->
  `CircuitVerify`.

## Dependency strategy

- **barretenberg-rs**: vendored in-tree at `vendor/barretenberg-rs/` as a path
  crate. It IS on crates.io at `5.0.0-rc.2`, but that release lacks the Android
  libc++ linker fix (see below), so we vendor a patched copy. The patch is one
  hunk in `build.rs`; see `vendor/barretenberg-rs/android-libcxx.patch` and
  `NOTICE`. Apache-2.0, matching upstream.
- **Prebuilt bb static lib**: `barretenberg-rs`'s `build.rs` downloads
  `libbb-external.a` from the GitHub release
  (`BARRETENBERG_VERSION=5.0.0-rc.2`). No C++ building required.
- **Noir ACVM crates** (`acir`, `acvm`, `bn254_blackbox_solver`, `noirc_abi`):
  git deps pinned to `tag = "v1.0.0-beta.22"`. They are not cleanly on crates.io
  at this version. They are only pulled in by the **optional `ultrahonk`
  feature**, so the core ClientIVC path depends **only** on the vendored
  `barretenberg-rs` + bundled inputs.
- **Android libc++**: prebuilt Zig `libc++.a`/`libc++abi.a` for both ABIs are
  shipped in `vendor/zig-libcxx/` so you don't need Zig. `scripts/build-zig-android-libcxx.sh`
  regenerates them from an NDK sysroot if you prefer.

## Repo layout

```
Cargo.toml                     workspace (vendor + 2 crates)
vendor/barretenberg-rs/        patched bb Rust bindings (Apache-2.0, NOTICE, patch)
vendor/zig-libcxx/{arm64,x86_64}/  prebuilt std::__1 libc++ for Android
crates/noir-prover/            prove logic: chonk.rs, srs.rs, prover.rs (core);
                               ultrahonk.rs + witgen.rs (feature "ultrahonk")
crates/noir-prover-jni/        JNI cdylib (libnoir_prover_jni.so)
android/                       Kotlin app (Gradle wrapper included)
  app/src/main/assets/{srs,flows,circuits}/   bundled run inputs
circuits/hash_chain512/        demo Noir circuit source
scripts/build-jni.sh           build the .so for both ABIs
scripts/prepare-srs.sh         (re)derive SRS slices from ~/.bb-crs
scripts/build-zig-android-libcxx.sh  regenerate the Zig libc++ archives
```

## Prerequisites

- Rust (stable) + `rustup target add aarch64-linux-android x86_64-linux-android`
- `cargo install cargo-ndk`
- Android SDK + NDK (tested: NDK 27.1.12297006), `ANDROID_HOME` and
  `ANDROID_NDK_HOME` set
- JDK 17 (for Gradle)
- An Android emulator AVD (API >= 29) or a physical arm64 device
- Network access (build.rs downloads the ~66 MB `libbb-external.a` once)

Zig is **not** required (prebuilt libc++ is shipped).

## Build & run (turnkey)

```bash
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006

# 1. Build libnoir_prover_jni.so for arm64-v8a + x86_64 into app/jniLibs.
#    Downloads libbb-external.a v5.0.0-rc.2 and links the in-repo Zig libc++.
./scripts/build-jni.sh

# 2. (Optional) re-derive SRS slices. The repo already bundles them; run this
#    only to regenerate. Needs ~/.bb-crs (any bb run creates it).
# ./scripts/prepare-srs.sh

# 3. Build the APK.
cd android && ./gradlew assembleDebug

# 4. Install & run on a booted emulator/device.
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n foundation.aztec.noirprover/.MainActivity
```

Tap a flow button. Expected (emulator): each flow logs per-circuit accumulate
times, `chonk prove ... verify ...`, and `VERIFIED: true`. Watch with:

```bash
adb logcat -s NoirProver
```

### Core-only .so (no Noir git deps)

To build a ClientIVC-only `.so` that depends solely on the vendored
`barretenberg-rs` (drops the UltraHonk demo and all noir crates):

```bash
JNI_FEATURES="--no-default-features" ./scripts/build-jni.sh
```

## Plugging in your own transaction

The core path proves any Aztec tx from its `ivc-inputs.msgpack` step stack:

1. Capture the stack from your tx via the aztec-packages `client_flows`
   benchmark harness (set `CAPTURE_IVC_FOLDER`), or your PXE integration that
   serializes `PrivateExecutionStep[]`.
2. Drop the `ivc-inputs.msgpack` into `android/app/src/main/assets/flows/`.
3. Add a `Flow(label, "flows/your_file.msgpack")` entry in `MainActivity.kt`.

For a standalone circuit (UltraHonk): `nargo compile` your Noir program, put the
`.json` + a JSON inputs file in `assets/circuits/`, and call
`NativeProver.prove(artifactBytes, inputsJson)`.

## The Android libc++ ABI trap (why the patch exists)

The released Android `libbb-external.a` is built with **Zig**, whose libc++ uses
the standard `std::__1` ABI namespace. The Android **NDK's** libc++ uses
`std::__ndk1` and **cannot** satisfy the `std::__1` symbols in the static lib: a
cdylib appears to link but dies at `dlopen`, and a binary fails at link time
with hundreds of undefined `std::__1::...` symbols.

Fix (baked into this repo):
1. The vendored `build.rs` does **not** emit `-lc++` for Android targets.
2. `scripts/build-jni.sh` links Zig's own `std::__1` `libc++.a` + `libc++abi.a`
   (shipped in `vendor/zig-libcxx/`) via `RUSTFLAGS` link-args, plus
   `-Wl,--no-undefined` to catch regressions.
3. Minimum Android API is **29**: the Zig-built objects use ELF TLS
   (`__tls_get_addr`), which bionic only exports from API 29 on x86_64.

On iOS this is unnecessary (Apple's libc++ is `std::__1`).

## Testnet (hybrid: real txs proven by the native prover)

The app proves precomputed stacks. To send a **real Aztec testnet tx** you also
need witness generation (PXE), tx assembly, node submission, and fees — none of
which are on-device. `testnet/` is a Node harness that supplies those via
aztec.js@5.0.0-rc.2 while **injecting this repo's native prover** as a custom
`PrivateKernelProver`: PXE does witgen, our native Rust prover produces the
ClientIVC proof (on-device via `BRIDGE=adb`, or on host as fallback), and the
proof is submitted to testnet. This is also the **reference implementation for a
future React-Native on-device PXE wallet** (see `testnet/README.md`).

Testnet params (verified live): node `https://v5.testnet.rpc.aztec-labs.com`,
L1 Sepolia (chain 11155111), rollup version 2787991301, SponsoredFPC
`0x1969…944d7` (deployed, confirmed) — all matching this repo's v5.0.0-rc.2 pin.

### Status — real txs landed on testnet

Both required flows landed on Aztec testnet, each with the ClientIVC proof
produced by this repo's native prover (host native lib; `BRIDGE=adb` proves the
same on the phone) and fees paid by the SponsoredFPC:

| Flow | tx hash | status | native prove | circuits |
|---|---|---|---|---|
| Account deploy (ecdsa_r1) | `0x1175e4c5ad3fb1f00019be5591052358c1f28d920bdf90ec2e174212f67c5aac` | checkpointed (block 2624) | 1,278 ms | 11 |
| Private token transfer | `0x29bc8d7dc3d3ac13d7ff55cdd84ce5d6b333311040924787a07ad84d10b5ca69` | proposed (block 2628) | 1,203 ms | 7 |

The transfer run also deployed a Token (`0x0639d5…`) and did a private
`mint_to_private` (`0x245d58…`), both native-proven. Explorer:
`https://testnet.aztecscan.xyz/tx/<hash>`.

The load-bearing correctness path is confirmed by these landing: native prover →
flat proof fields (layout == bb.js `flattenChonkProofFields`) →
`ChonkProofWithPublicInputs.fromBufferArray(...)` → PXE `node.sendTx` → accepted
and checkpointed on-chain.

**The unblock:** the account-deploy tx must publish the account contract class
in-tx (`skipClassPublication: false`) — the ECDSA-R class was not already
published on this testnet instance, so skipping it caused a
`verifyReadRequests` "unknown nullifier" during simulation. With class
publication enabled and `from: NO_FROM` (self-deploy), it lands.

### Benchmark (measured on this run)

| Flow | connect+PXE | witgen+prove+submit+mined | native ClientIVC prove | native peak RSS | total |
|---|---|---|---|---|---|
| Account deploy | 1,451 ms | 18,144 ms | 1,278 ms | 372 MB | 19,732 ms |
| Private transfer (deploy+mint+transfer) | 1,516 ms | — | 1,203 ms (transfer) | 320–353 MB | 48,738 ms |

The transfer total covers three sequential mined txs (token deploy 18,753 ms,
mint 16,973 ms, transfer 11,369 ms). "witgen+prove+submit+mined" is one phase
here because `send()` waits for mining; the native prove is the sub-second-ish
ClientIVC portion, the rest is PXE witgen + network inclusion. First tx is
slower (proving-key download); testnet inclusion time varies. Proving here ran
on the host native lib; `BRIDGE=adb` produces the identical proof on-device
(~1.4–2.2 s ClientIVC on the emulator, per the app benchmarks above).

## Provenance / attribution

All ZK machinery is Aztec's. Vendored/derived from
[aztec-packages](https://github.com/AztecProtocol/aztec-packages) tag
**v5.0.0-rc.2** and [noir](https://github.com/noir-lang/noir) tag
**v1.0.0-beta.22**. `vendor/barretenberg-rs/` is a patched copy of
`barretenberg/rust/barretenberg-rs` (Apache-2.0). The bundled SRS slices are
prefixes of the public Aztec/Ignition trusted-setup CRS (public data, no
secrets). This project (the prover orchestration crate, JNI layer, Android app,
build scripts, and the libc++ link recipe) is the new work here, also Apache-2.0.

## Next steps

- On-device PXE simulation (produce tx witness stacks on the device, not just
  prove precomputed ones).
- iOS via the released `arm64-ios` static lib (no libc++ workaround needed).
- Ship SRS compressed (32 B/point + on-device `SrsInitSrs` decompression, which
  also SHA-256-pins the chunks).
- Physical arm64 device benchmarks.
