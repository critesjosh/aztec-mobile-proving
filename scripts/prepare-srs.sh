#!/usr/bin/env bash
# Prepare the SRS asset slices the app bundles. These are prefix slices of the
# public Aztec/Ignition trusted-setup CRS files (no secrets). If you already
# have ~/.bb-crs (created by any bb run), this slices from there; otherwise it
# downloads the points from the public CRS bucket.
#
# Outputs (into android/app/src/main/assets/srs):
#   bn254_g1.dat    2^19 uncompressed G1 points (64 B each) = 32 MiB
#   bn254_g2.dat    single 128-byte G2 point
#   grumpkin_g1.dat 2^16 Grumpkin points (64 B each) = 4 MiB  (Chonk/ECCVM)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out="$repo_root/android/app/src/main/assets/srs"
mkdir -p "$out"

crs="${BB_CRS_DIR:-$HOME/.bb-crs}"
bn254_points="${BN254_POINTS:-524288}"      # 2^19
grumpkin_points="${GRUMPKIN_POINTS:-65536}" # 2^16

if [ ! -f "$crs/bn254_g1.dat" ] || [ ! -f "$crs/bn254_g2.dat" ] || [ ! -f "$crs/grumpkin_g1_v2.flat.dat" ]; then
  echo "CRS files not found in $crs."
  echo "Run any 'bb' command once (it downloads the CRS to ~/.bb-crs), or set BB_CRS_DIR."
  exit 1
fi

# 64 bytes per uncompressed BN254/Grumpkin point.
dd if="$crs/bn254_g1.dat"          of="$out/bn254_g1.dat"    bs=64 count="$bn254_points"    status=none
cp "$crs/bn254_g2.dat"             "$out/bn254_g2.dat"
dd if="$crs/grumpkin_g1_v2.flat.dat" of="$out/grumpkin_g1.dat" bs=64 count="$grumpkin_points" status=none

echo "SRS slices written to $out:"
ls -la "$out"
