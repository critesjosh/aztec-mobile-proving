//! Core prover: the in-process Barretenberg instance and SRS initialization.
//! Depends only on `barretenberg-rs`. The ClientIVC (Chonk) tx-proving flow
//! lives in `chonk.rs`; the optional ACVM/UltraHonk path lives in `ultrahonk.rs`
//! (feature = "ultrahonk").

use std::io::Read;

use flate2::read::GzDecoder;

use barretenberg_rs::api::BarretenbergApi;
use barretenberg_rs::backends::FfiBackend;
use barretenberg_rs::generated_types::ProofSystemSettings;

use crate::error::Result;
use crate::srs::SrsData;

/// A stateful prover bound to the in-process Barretenberg instance.
///
/// Not thread-safe: bbapi keeps global state (SRS), and `FfiBackend` must not
/// be called concurrently. Wrap in a mutex for multi-threaded hosts.
pub struct NoirProver {
    api: BarretenbergApi<FfiBackend>,
}

impl NoirProver {
    pub fn new() -> Result<Self> {
        let backend = FfiBackend::new()?;
        Ok(Self {
            api: BarretenbergApi::new(backend),
        })
    }

    /// Feed BN254 SRS points into barretenberg's global CRS store.
    /// Must be called before the first prove/verify.
    pub fn init_srs(&mut self, srs: &SrsData) -> Result<()> {
        self.api.srs_init_srs(&srs.g1, srs.num_points, &srs.g2)?;
        Ok(())
    }

    /// Feed Grumpkin SRS points (required for Chonk/ClientIVC only).
    pub fn init_grumpkin_srs(&mut self, g1: &[u8], num_points: u32) -> Result<()> {
        self.api.srs_init_grumpkin_srs(g1, num_points)?;
        Ok(())
    }

    /// Access the underlying bbapi for commands not wrapped in a helper.
    pub fn api(&mut self) -> &mut BarretenbergApi<FfiBackend> {
        &mut self.api
    }
}

pub(crate) fn default_settings() -> ProofSystemSettings {
    ProofSystemSettings {
        ipa_accumulation: false,
        oracle_hash_type: "poseidon2".to_string(),
        disable_zk: false,
        optimized_solidity_verifier: false,
    }
}

pub(crate) fn gunzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| crate::error::ProverError::Artifact(format!("gunzip failed: {e}")))?;
    Ok(out)
}
