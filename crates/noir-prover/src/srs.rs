//! On-device SRS loading.
//!
//! Barretenberg's FFI build has no filesystem/network CRS fallback, so the
//! host application must feed trusted-setup points explicitly via the
//! `SrsInitSrs` / `SrsInitGrumpkinSrs` msgpack commands before proving.
//!
//! The expected data layout matches barretenberg's CRS files (`~/.bb-crs`):
//! - BN254 G1: raw uncompressed affine points, 64 bytes each (a prefix slice
//!   of `bn254_g1.dat` is valid — points are in ascending SRS order).
//! - BN254 G2: single 128-byte point (`bn254_g2.dat`).
//! - Grumpkin G1: raw affine points, 64 bytes each (`grumpkin_g1_v2.flat.dat`),
//!   only needed for Chonk/ClientIVC (ECCVM).

use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::error::{ProverError, Result};

pub const BN254_POINT_SIZE: usize = 64;
pub const G2_POINT_SIZE: usize = 128;

pub struct SrsData {
    pub g1: Vec<u8>,
    pub num_points: u32,
    pub g2: Vec<u8>,
}

/// Read the first `num_points` BN254 G1 points plus the G2 point from
/// bb-format CRS files.
pub fn load_bn254_srs(g1_path: &Path, g2_path: &Path, num_points: u32) -> Result<SrsData> {
    let g1 = read_prefix(g1_path, num_points as usize * BN254_POINT_SIZE)?;
    let mut g2 = Vec::new();
    File::open(g2_path)?.read_to_end(&mut g2)?;
    if g2.len() != G2_POINT_SIZE {
        return Err(ProverError::Srs(format!(
            "expected {}-byte G2 point, got {} bytes",
            G2_POINT_SIZE,
            g2.len()
        )));
    }
    Ok(SrsData { g1, num_points, g2 })
}

/// Read the first `num_points` Grumpkin G1 points from a bb-format flat file.
pub fn load_grumpkin_srs(g1_path: &Path, num_points: u32) -> Result<Vec<u8>> {
    read_prefix(g1_path, num_points as usize * BN254_POINT_SIZE)
}

fn read_prefix(path: &Path, len: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let mut file = File::open(path)?;
    file.read_exact(&mut buf).map_err(|e| {
        ProverError::Srs(format!(
            "failed to read {} bytes from {}: {e}",
            len,
            path.display()
        ))
    })?;
    Ok(buf)
}
