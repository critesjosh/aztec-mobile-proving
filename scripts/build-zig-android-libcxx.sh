#!/usr/bin/env bash
# Produce Zig's libc++/libc++abi static archives for Android targets.
#
# The released Android libbb-external.a is built with Zig, whose libc++ uses
# the standard std::__1 ABI namespace. The NDK's libc++ uses std::__ndk1 and
# cannot satisfy those symbols, so consumers must link Zig's libc++ instead.
# Zig builds its libc++ for a target as a cache side effect of attempting a
# link; the link itself fails (Zig cannot fully link Android executables) but
# the archives land in the cache, from where this script collects them.
#
# Usage: build-zig-android-libcxx.sh <output-dir>
# Produces <output-dir>/{arm64,x86_64}/{libc++.a,libc++abi.a}
set -euo pipefail

out=${1:?usage: build-zig-android-libcxx.sh <output-dir>}
zig=${ZIG:-zig}
ndk=${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must be set}
sysroot="$ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
api=29

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo 'int main(){return 0;}' > "$tmp/dummy.cpp"

for pair in "aarch64:arm64" "x86_64:x86_64"; do
  target=${pair%%:*}
  outname=${pair##*:}
  libc_txt="$tmp/libc-$target.txt"
  cat > "$libc_txt" <<EOF
include_dir=$sysroot/usr/include
sys_include_dir=$sysroot/usr/include/$target-linux-android
crt_dir=$sysroot/usr/lib/$target-linux-android/$api
msvc_lib_dir=
kernel32_lib_dir=
gcc_dir=
EOF
  # The link fails (no full bionic support in zig); the libc++ archives are
  # still built into the zig cache. Track them via a fresh local cache dir.
  ZIG_LIBC="$libc_txt" ZIG_LOCAL_CACHE_DIR="$tmp/cache-$target" ZIG_GLOBAL_CACHE_DIR="$tmp/cache-$target" \
    "$zig" c++ -target "$target-linux-android" "$tmp/dummy.cpp" -o "$tmp/dummy-$target" 2>/dev/null || true

  mkdir -p "$out/$outname"
  cxx=$(find "$tmp/cache-$target" -name 'libc++.a' | head -1)
  cxxabi=$(find "$tmp/cache-$target" -name 'libc++abi.a' | head -1)
  if [[ -z "$cxx" || -z "$cxxabi" ]]; then
    echo "ERROR: zig did not produce libc++ archives for $target-linux-android" >&2
    exit 1
  fi
  cp "$cxx" "$cxxabi" "$out/$outname/"
  echo "$outname: $(ls "$out/$outname")"
done
