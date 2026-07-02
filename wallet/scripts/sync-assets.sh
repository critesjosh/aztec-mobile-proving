#!/usr/bin/env bash
# Assemble the wallet app's regenerable assets (all gitignored):
#   - WebView PXE bundle: wallet/pxe-web/dist -> app assets/pxe
#   - SRS slices: repo android app assets (or scripts/prepare-srs.sh output)
#   - libnoir_prover_jni.so: built by scripts/build-jni.sh at the repo root
#     into the root android app; copied into the wallet app here.
#
# Usage: wallet/scripts/sync-assets.sh   (after `npm run build` in wallet/pxe-web)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
app="$repo_root/wallet/app/android/app/src/main"
dist="$repo_root/wallet/pxe-web/dist"
srs_src="$repo_root/android/app/src/main/assets/srs"
jni_src="$repo_root/android/app/src/main/jniLibs"

[ -d "$dist" ] || { echo "missing $dist — run 'npm run build' in wallet/pxe-web"; exit 1; }
[ -f "$srs_src/bn254_g1.dat" ] || { echo "missing SRS at $srs_src — run scripts/prepare-srs.sh"; exit 1; }
[ -f "$jni_src/arm64-v8a/libnoir_prover_jni.so" ] || {
  echo "missing jni libs at $jni_src — run scripts/build-jni.sh"; exit 1; }

rm -rf "$app/assets/pxe"
mkdir -p "$app/assets/pxe" "$app/assets/srs" "$app/jniLibs"
cp -r "$dist/." "$app/assets/pxe/"
cp "$srs_src"/*.dat "$app/assets/srs/"
cp -r "$jni_src/." "$app/jniLibs/"

echo "assets synced:"
du -sh "$app/assets/pxe" "$app/assets/srs" "$app/jniLibs"
