//! ClientIVC ("Chonk") proving of full Aztec transactions from precomputed
//! private-execution step stacks (`ivc-inputs.msgpack`).
//!
//! The witness stacks are produced off-device by PXE simulation of the tx
//! (see `yarn-project/end-to-end/src/bench/client_flows`); this module runs
//! the on-device half: accumulate each circuit, produce the Chonk proof, and
//! verify it. The call sequence mirrors
//! `barretenberg/cpp/src/barretenberg/bbapi/bbapi_chonk_pinned_inputs.test.cpp`.

use std::io::Read;
use std::time::Instant;

use flate2::read::GzDecoder;
use serde::Deserialize;
use serde_bytes::ByteBuf;

use barretenberg_rs::generated_types::{ChonkProof, CircuitInput, CircuitInputNoVK};

use crate::error::{ProverError, Result};
use crate::prover::NoirProver;

/// One private execution step: a circuit in the transaction's call stack.
/// `bytecode` and `witness` are gzipped in the file (msgpack map field
/// `functionName` in camelCase).
#[derive(Deserialize)]
pub struct ChonkStep {
    pub bytecode: ByteBuf,
    pub witness: ByteBuf,
    pub vk: ByteBuf,
    #[serde(rename = "functionName")]
    pub function_name: String,
}

pub struct ChonkStepTiming {
    pub function_name: String,
    pub load_ms: u128,
    pub accumulate_ms: u128,
}

pub struct ChonkFlowOutput {
    pub proof: ChonkProof,
    /// Flattened proof fields (32-byte big-endian Fr each), the layout the
    /// PXE's ChonkProofWithPublicInputs.fromBufferArray expects.
    pub proof_fields: Vec<Vec<u8>>,
    pub vk: Vec<u8>,
    pub verified: bool,
    pub num_circuits: usize,
    pub steps: Vec<ChonkStepTiming>,
    pub prove_ms: u128,
    pub compute_vk_ms: u128,
    pub verify_ms: u128,
    pub total_ms: u128,
    pub proof_size_bytes: usize,
}

/// Parse an `ivc-inputs.msgpack` buffer and gunzip each step's bytecode and
/// witness (matching `PrivateExecutionStepRaw::load_and_decompress`).
pub fn parse_ivc_inputs(bytes: &[u8]) -> Result<Vec<ChonkStep>> {
    let mut steps: Vec<ChonkStep> = rmp_serde::from_slice(bytes)
        .map_err(|e| ProverError::Artifact(format!("failed to parse ivc inputs msgpack: {e}")))?;
    for step in &mut steps {
        step.bytecode = ByteBuf::from(gunzip(&step.bytecode)?);
        step.witness = ByteBuf::from(gunzip(&step.witness)?);
    }
    Ok(steps)
}

impl NoirProver {
    /// Run the full ClientIVC flow over parsed execution steps:
    /// start → (load + accumulate)* → prove → compute hiding-circuit VK → verify.
    pub fn chonk_prove_flow(&mut self, steps: Vec<ChonkStep>) -> Result<ChonkFlowOutput> {
        if steps.is_empty() {
            return Err(ProverError::Artifact("no execution steps".to_string()));
        }
        let total_timer = Instant::now();
        let hiding_bytecode = steps.last().unwrap().bytecode.to_vec();
        let num_circuits = steps.len();

        self.api().chonk_start(num_circuits as u32)?;

        let mut step_timings = Vec::with_capacity(num_circuits);
        for step in steps {
            // Cooperative cancel point: check before starting each circuit's
            // load+accumulate. See abort.rs for the honest scope (a single bb
            // call still runs to completion; abort lands at this boundary).
            if crate::abort::is_aborted() {
                return Err(ProverError::Aborted);
            }
            let t = Instant::now();
            self.api().chonk_load(CircuitInput {
                name: step.function_name.clone(),
                bytecode: step.bytecode.into_vec(),
                verification_key: step.vk.into_vec(),
            })?;
            let load_ms = t.elapsed().as_millis();

            let t = Instant::now();
            self.api().chonk_accumulate(&step.witness)?;
            step_timings.push(ChonkStepTiming {
                function_name: step.function_name,
                load_ms,
                accumulate_ms: t.elapsed().as_millis(),
            });
        }

        // Last cancel point before the final (non-interruptible) prove.
        if crate::abort::is_aborted() {
            return Err(ProverError::Aborted);
        }
        let t = Instant::now();
        let proof = self.api().chonk_prove()?.proof;
        let prove_ms = t.elapsed().as_millis();

        let t = Instant::now();
        let vk = self
            .api()
            .chonk_compute_vk(
                CircuitInputNoVK {
                    name: "hiding".to_string(),
                    bytecode: hiding_bytecode,
                },
                true,
            )?
            .bytes;
        let compute_vk_ms = t.elapsed().as_millis();

        let t = Instant::now();
        let verified = self.api().chonk_verify(proof.clone(), &vk)?.valid;
        let verify_ms = t.elapsed().as_millis();

        let proof_size_bytes = proof_size(&proof);
        let proof_fields = flatten_proof_fields(&proof);

        Ok(ChonkFlowOutput {
            proof,
            proof_fields,
            vk,
            verified,
            num_circuits,
            steps: step_timings,
            prove_ms,
            compute_vk_ms,
            verify_ms,
            total_ms: total_timer.elapsed().as_millis(),
            proof_size_bytes,
        })
    }
}

/// Flatten a structured ChonkProof into the flat `Fr[]` layout that
/// `ChonkProofWithPublicInputs.fromBufferArray` expects. Order matches bb.js
/// `flattenChonkProofFields` and C++ `ChonkProof::to_field_elements()`:
/// hiding_oink_proof, merge_proof, eccvm_proof, ipa_proof, joint_proof.
pub fn flatten_proof_fields(proof: &ChonkProof) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    out.extend(proof.hiding_oink_proof.iter().cloned());
    out.extend(proof.merge_proof.iter().cloned());
    out.extend(proof.eccvm_proof.iter().cloned());
    out.extend(proof.ipa_proof.iter().cloned());
    out.extend(proof.joint_proof.iter().cloned());
    out
}

fn proof_size(proof: &ChonkProof) -> usize {
    [
        &proof.hiding_oink_proof,
        &proof.merge_proof,
        &proof.eccvm_proof,
        &proof.ipa_proof,
        &proof.joint_proof,
    ]
    .iter()
    .map(|part| part.iter().map(Vec::len).sum::<usize>())
    .sum()
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| ProverError::Artifact(format!("gunzip failed: {e}")))?;
    Ok(out)
}
