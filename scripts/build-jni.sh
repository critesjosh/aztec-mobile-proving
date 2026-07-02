#!/usr/bin/env bash
# Build libnoir_prover_jni.so for both Android ABIs and place them in the app's
# jniLibs. Downloads the prebuilt v5.0.0-rc.2 libbb-external.a via build.rs
# (BARRETENBERG_VERSION), and links the in-repo Zig libc++ archives to satisfy
# the std::__1 ABI (see README "Android libc++ trap").
#
# Prereqs: rustup targets aarch64-linux-android + x86_64-linux-android,
#          cargo-ndk, ANDROID_NDK_HOME. See README.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to your NDK (e.g. \$ANDROID_HOME/ndk/27.1.12297006)}"
export BARRETENBERG_VERSION="${BARRETENBERG_VERSION:-5.0.0-rc.2}"

libcxx="$repo_root/vendor/zig-libcxx"
jni_out="$repo_root/android/app/src/main/jniLibs"
platform="${ANDROID_PLATFORM:-29}"
# --no-default-features on the jni crate => ClientIVC-only .so (no noir crates).
features_arg="${JNI_FEATURES:-}"

build() {
  local ndk_abi="$1" rust_arch="$2"
  echo ">>> Building $ndk_abi ($rust_arch) with BARRETENBERG_VERSION=$BARRETENBERG_VERSION"
  RUSTFLAGS="-C link-arg=-Wl,--allow-multiple-definition \
    -C link-arg=$libcxx/$rust_arch/libc++.a \
    -C link-arg=$libcxx/$rust_arch/libc++abi.a \
    -C link-arg=-Wl,--no-undefined" \
  cargo ndk -t "$ndk_abi" --platform "$platform" -o "$jni_out" build --release \
    -p noir-prover-jni $features_arg
}

build x86_64      x86_64
build arm64-v8a   arm64

# Strip for smaller APK.
strip_bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
if [ -x "$strip_bin" ]; then
  "$strip_bin" --strip-unneeded \
    "$jni_out/x86_64/libnoir_prover_jni.so" \
    "$jni_out/arm64-v8a/libnoir_prover_jni.so"
fi

echo ">>> Done. jniLibs:"
ls -la "$jni_out"/*/libnoir_prover_jni.so
