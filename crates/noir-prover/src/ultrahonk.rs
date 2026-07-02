//! Optional on-device ACVM witness generation + standalone UltraHonk proving of
//! a compiled Noir program (nargo `.json` artifact). Gated behind the
//! `ultrahonk` feature so the core ClientIVC path depends only on
//! `barretenberg-rs`.

use std::time::Instant;

use acir::circuit::Program;
use acir::FieldElement;
use base64::Engine;
use noirc_abi::input_parser::Format;
use noirc_abi::Abi;
use serde::Deserialize;

use barretenberg_rs::generated_types::{CircuitInput, CircuitInputNoVK};

use crate::error::{ProverError, Result};
use crate::prover::{default_settings, gunzip, NoirProver};
use crate::witgen::execute_program;

/// The subset of a nargo `.json` program artifact needed for proving.
#[derive(Deserialize)]
struct ProgramArtifact {
    abi: Abi,
    /// base64(gzip(format_marker + msgpack)) as emitted by nargo.
    bytecode: String,
}

pub struct ProveOutput {
    pub proof: Vec<Vec<u8>>,
    pub public_inputs: Vec<Vec<u8>>,
    pub vk: Vec<u8>,
    pub witgen_ms: u128,
    pub vk_ms: u128,
    pub prove_ms: u128,
}

pub struct VerifyOutput {
    pub verified: bool,
    pub verify_ms: u128,
}

impl NoirProver {
    /// Prove a compiled Noir program (nargo JSON artifact bytes) with the
    /// given ABI-encoded inputs (JSON string, same values as Prover.toml).
    pub fn prove(&mut self, artifact_json: &[u8], inputs_json: &str) -> Result<ProveOutput> {
        let artifact: ProgramArtifact = serde_json::from_slice(artifact_json)
            .map_err(|e| ProverError::Artifact(format!("failed to parse artifact JSON: {e}")))?;

        let bytecode_gz = base64::engine::general_purpose::STANDARD
            .decode(&artifact.bytecode)
            .map_err(|e| ProverError::Artifact(format!("bytecode is not valid base64: {e}")))?;

        // bb takes the ungzipped (marker + msgpack) buffer; the ACVM parses
        // the same bytes through the acir crate.
        let acir_buf = gunzip(&bytecode_gz)?;
        let program: Program<FieldElement> = Program::deserialize_program(&bytecode_gz)
            .map_err(|e| ProverError::Artifact(format!("failed to decode ACIR program: {e}")))?;

        let input_map = Format::Json
            .parse(inputs_json, &artifact.abi)
            .map_err(|e| ProverError::Inputs(format!("failed to parse inputs: {e}")))?;
        let initial_witness = artifact
            .abi
            .encode(&input_map, None)
            .map_err(|e| ProverError::Inputs(format!("failed to ABI-encode inputs: {e}")))?;

        let t = Instant::now();
        let witness_stack = execute_program(&program, initial_witness)?;
        let witgen_ms = t.elapsed().as_millis();

        let witness_gz = witness_stack
            .serialize()
            .map_err(|e| ProverError::Witgen(format!("failed to serialize witness: {e}")))?;
        let witness_buf = gunzip(&witness_gz)?;

        let settings = default_settings();

        let t = Instant::now();
        let vk = self
            .api()
            .circuit_compute_vk(
                CircuitInputNoVK {
                    name: "circuit".to_string(),
                    bytecode: acir_buf.clone(),
                },
                settings.clone(),
            )?
            .bytes;
        let vk_ms = t.elapsed().as_millis();

        let t = Instant::now();
        let resp = self.api().circuit_prove(
            CircuitInput {
                name: "circuit".to_string(),
                bytecode: acir_buf,
                verification_key: vk.clone(),
            },
            &witness_buf,
            settings,
        )?;
        let prove_ms = t.elapsed().as_millis();

        Ok(ProveOutput {
            proof: resp.proof,
            public_inputs: resp.public_inputs,
            vk,
            witgen_ms,
            vk_ms,
            prove_ms,
        })
    }

    /// Verify an UltraHonk proof against a verification key.
    pub fn verify(
        &mut self,
        vk: &[u8],
        public_inputs: Vec<Vec<u8>>,
        proof: Vec<Vec<u8>>,
    ) -> Result<VerifyOutput> {
        let t = Instant::now();
        let resp = self
            .api()
            .circuit_verify(vk, public_inputs, proof, default_settings())?;
        Ok(VerifyOutput {
            verified: resp.verified,
            verify_ms: t.elapsed().as_millis(),
        })
    }

    /// Gate counts for a compiled program: (acir_opcodes, gates, dyadic_gates).
    pub fn stats(&mut self, artifact_json: &[u8]) -> Result<(u32, u32, u32)> {
        let artifact: ProgramArtifact = serde_json::from_slice(artifact_json)
            .map_err(|e| ProverError::Artifact(format!("failed to parse artifact JSON: {e}")))?;
        let bytecode_gz = base64::engine::general_purpose::STANDARD
            .decode(&artifact.bytecode)
            .map_err(|e| ProverError::Artifact(format!("bytecode is not valid base64: {e}")))?;
        let resp = self.api().circuit_stats(
            CircuitInput {
                name: "circuit".to_string(),
                bytecode: gunzip(&bytecode_gz)?,
                verification_key: Vec::new(),
            },
            false,
            default_settings(),
        )?;
        Ok((resp.num_acir_opcodes, resp.num_gates, resp.num_gates_dyadic))
    }
}
