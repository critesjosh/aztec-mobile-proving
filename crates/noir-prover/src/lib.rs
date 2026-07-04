//! noir-prover: on-device Barretenberg proving.
//!
//! Core (default features): ClientIVC ("Chonk") proving + verification of full
//! Aztec transactions from a precomputed `ivc-inputs.msgpack` step stack, plus
//! explicit SRS initialization. Depends only on `barretenberg-rs`.
//!
//! Optional (`ultrahonk` feature): on-device ACVM witness generation
//! (noir acvm crates) + standalone UltraHonk proving/verification of a compiled
//! Noir program.

pub mod abort;
pub mod chonk;
pub mod error;
pub mod prover;
pub mod srs;

#[cfg(feature = "ultrahonk")]
pub mod ultrahonk;
#[cfg(feature = "ultrahonk")]
pub mod witgen;

pub use abort::{clear_abort, is_aborted, request_abort};
pub use chonk::{flatten_proof_fields, parse_ivc_inputs, ChonkFlowOutput, ChonkStep};
pub use error::{ProverError, Result};
pub use prover::NoirProver;
pub use srs::{load_bn254_srs, load_grumpkin_srs, SrsData};

#[cfg(feature = "ultrahonk")]
pub use ultrahonk::{ProveOutput, VerifyOutput};
