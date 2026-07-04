//! JNI surface for the Kotlin app (class `foundation.aztec.noirprover.NativeProver`).
//!
//! All entrypoints return JSON strings (or throw a Java RuntimeException) so
//! the Kotlin side stays free of manual (de)serialization. bbapi keeps global
//! state and is not thread-safe, so a single global prover behind a mutex
//! serializes access.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use jni::objects::{JByteArray, JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::json;

use noir_prover::{NoirProver, SrsData};

static PROVER: Mutex<Option<NoirProver>> = Mutex::new(None);

#[cfg(feature = "ultrahonk")]
static LAST_PROOF: Mutex<Option<StoredProof>> = Mutex::new(None);

#[cfg(feature = "ultrahonk")]
struct StoredProof {
    vk: Vec<u8>,
    public_inputs: Vec<Vec<u8>>,
    proof: Vec<Vec<u8>>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn throw_and_default(env: &mut JNIEnv, msg: &str) -> jstring {
    let _ = env.throw_new("java/lang/RuntimeException", msg);
    std::ptr::null_mut()
}

fn run_json(env: &mut JNIEnv, f: impl FnOnce() -> Result<serde_json::Value, String>) -> jstring {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => match env.new_string(value.to_string()) {
            Ok(s) => s.into_raw(),
            Err(e) => throw_and_default(env, &format!("JNI string error: {e}")),
        },
        Ok(Err(msg)) => throw_and_default(env, &msg),
        Err(_) => throw_and_default(env, "panic in native prover"),
    }
}

/// Initialize barretenberg with SRS points (bb CRS file layout: 64-byte
/// uncompressed G1 points, 128-byte G2 point). `grumpkin_g1` may be empty if
/// only UltraHonk proving is needed; Chonk requires it.
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_initSrs(
    mut env: JNIEnv,
    _class: JClass,
    g1: JByteArray,
    g2: JByteArray,
    grumpkin_g1: JByteArray,
) -> jstring {
    let g1_bytes = match env.convert_byte_array(&g1) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad g1 array: {e}")),
    };
    let g2_bytes = match env.convert_byte_array(&g2) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad g2 array: {e}")),
    };
    let grumpkin_bytes = match env.convert_byte_array(&grumpkin_g1) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad grumpkin array: {e}")),
    };
    run_json(&mut env, move || {
        // Validate buffer sizes at the JNI boundary (unlike srs.rs file loading,
        // these come straight from Kotlin). 64 bytes/G1 point, 128-byte G2.
        let pt = noir_prover::srs::BN254_POINT_SIZE;
        if g1_bytes.is_empty() || g1_bytes.len() % pt != 0 {
            return Err(format!("g1 length {} must be a positive multiple of {pt}", g1_bytes.len()));
        }
        if g2_bytes.len() != noir_prover::srs::G2_POINT_SIZE {
            return Err(format!(
                "g2 length {} must be {}",
                g2_bytes.len(),
                noir_prover::srs::G2_POINT_SIZE
            ));
        }
        if grumpkin_bytes.len() % pt != 0 {
            return Err(format!("grumpkin length {} must be a multiple of {pt}", grumpkin_bytes.len()));
        }
        let num_points = (g1_bytes.len() / pt) as u32;
        let grumpkin_points = (grumpkin_bytes.len() / pt) as u32;
        let mut prover = NoirProver::new().map_err(|e| e.to_string())?;
        prover
            .init_srs(&SrsData {
                g1: g1_bytes,
                num_points,
                g2: g2_bytes,
            })
            .map_err(|e| e.to_string())?;
        if grumpkin_points > 0 {
            prover
                .init_grumpkin_srs(&grumpkin_bytes, grumpkin_points)
                .map_err(|e| e.to_string())?;
        }
        *PROVER.lock().unwrap() = Some(prover);
        Ok(json!({ "ok": true, "num_points": num_points, "grumpkin_points": grumpkin_points }))
    })
}

/// Prove + verify a full Aztec transaction via ClientIVC from a bundled
/// `ivc-inputs.msgpack` asset. Returns per-step and total timings as JSON.
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_chonkProve(
    mut env: JNIEnv,
    _class: JClass,
    ivc_inputs: JByteArray,
) -> jstring {
    let inputs = match env.convert_byte_array(&ivc_inputs) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad ivc inputs array: {e}")),
    };
    run_json(&mut env, move || {
        // Acquire the prover mutex FIRST, then clear any stale abort. Clearing
        // before the lock would let a second prove (blocked here on the mutex)
        // wipe an abort meant for the first, still-running prove. Once we hold
        // the lock the previous prove has fully returned, so clearing here only
        // discards a request that can no longer apply to anyone but us.
        let mut guard = PROVER.lock().unwrap();
        noir_prover::clear_abort();
        let prover = guard.as_mut().ok_or("initSrs must be called first")?;
        let steps = noir_prover::parse_ivc_inputs(&inputs).map_err(|e| e.to_string())?;
        let step_names: Vec<String> = steps.iter().map(|s| s.function_name.clone()).collect();
        let out = prover.chonk_prove_flow(steps).map_err(|e| e.to_string())?;
        Ok(json!({
            "verified": out.verified,
            "num_circuits": out.num_circuits,
            "circuits": step_names,
            "steps": out.steps.iter().map(|s| json!({
                "name": s.function_name,
                "load_ms": s.load_ms,
                "accumulate_ms": s.accumulate_ms,
            })).collect::<Vec<_>>(),
            "prove_ms": out.prove_ms,
            "vk_ms": out.compute_vk_ms,
            "verify_ms": out.verify_ms,
            "total_ms": out.total_ms,
            "proof_size_bytes": out.proof_size_bytes,
            "vk_bytes": out.vk.len(),
            "peak_rss_mb": peak_rss_mb(),
            // Flat proof fields + vk (hex) so a WebView-hosted PXE can rebuild
            // ChonkProofWithPublicInputs and submit the tx (RN spike path).
            "proof_fields": out.proof_fields.iter().map(|f| hex(f)).collect::<Vec<_>>(),
            "vk": hex(&out.vk),
        }))
    })
}

/// Request that an in-flight `chonkProve` stop at its next circuit-accumulation
/// boundary. Safe to call from another thread while a prove holds the prover
/// mutex (this sets an independent atomic flag; it does not touch the prover).
/// Best-effort: see crates/noir-prover/src/abort.rs for the honest scope — a
/// single barretenberg call, including the final Chonk prove, always runs to
/// completion, so cancel lands at the next boundary, not instantly.
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_requestAbort(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    run_json(&mut env, move || {
        noir_prover::request_abort();
        Ok(json!({ "ok": true }))
    })
}

fn peak_rss_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in status.lines() {
        if let Some(kb) = line.strip_prefix("VmHWM:") {
            let kb: f64 = kb.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0.0);
            return (kb / 1024.0 * 10.0).round() / 10.0;
        }
    }
    0.0
}

/// Generate an UltraHonk proof. Returns JSON with hex-encoded proof fields,
/// public inputs, vk, and stage timings. The proof is also cached natively so
/// `verifyLast` can run without shipping the buffers back across JNI.
#[cfg(feature = "ultrahonk")]
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_prove(
    mut env: JNIEnv,
    _class: JClass,
    artifact_json: JByteArray,
    inputs_json: JString,
) -> jstring {
    let artifact = match env.convert_byte_array(&artifact_json) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad artifact array: {e}")),
    };
    let inputs: String = match env.get_string(&inputs_json) {
        Ok(s) => s.into(),
        Err(e) => return throw_and_default(&mut env, &format!("bad inputs string: {e}")),
    };
    run_json(&mut env, move || {
        let mut guard = PROVER.lock().unwrap();
        let prover = guard.as_mut().ok_or("initSrs must be called first")?;
        let stats = prover.stats(&artifact).ok();
        let out = prover.prove(&artifact, &inputs).map_err(|e| e.to_string())?;
        let result = json!({
            "proof_fields": out.proof.len(),
            "public_inputs": out.public_inputs.iter().map(|f| hex(f)).collect::<Vec<_>>(),
            "proof_first_field": out.proof.first().map(|f| hex(f)),
            "vk_bytes": out.vk.len(),
            "num_acir_opcodes": stats.map(|s| s.0),
            "num_gates": stats.map(|s| s.1),
            "num_gates_dyadic": stats.map(|s| s.2),
            "witgen_ms": out.witgen_ms,
            "vk_ms": out.vk_ms,
            "prove_ms": out.prove_ms,
            "peak_rss_mb": peak_rss_mb(),
        });
        *LAST_PROOF.lock().unwrap() = Some(StoredProof {
            vk: out.vk,
            public_inputs: out.public_inputs,
            proof: out.proof,
        });
        Ok(result)
    })
}

/// Verify the most recently generated proof. Returns JSON {verified, verify_ms}.
#[cfg(feature = "ultrahonk")]
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_verifyLast(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    run_json(&mut env, move || {
        let mut guard = PROVER.lock().unwrap();
        let prover = guard.as_mut().ok_or("initSrs must be called first")?;
        let stored_guard = LAST_PROOF.lock().unwrap();
        let stored = stored_guard.as_ref().ok_or("no proof generated yet")?;
        let out = prover
            .verify(
                &stored.vk,
                stored.public_inputs.clone(),
                stored.proof.clone(),
            )
            .map_err(|e| e.to_string())?;
        Ok(json!({ "verified": out.verified, "verify_ms": out.verify_ms }))
    })
}

/// bbapi smoke test callable before SRS init: blake2s over the input bytes.
#[no_mangle]
pub extern "system" fn Java_foundation_aztec_noirprover_NativeProver_blake2s(
    mut env: JNIEnv,
    _class: JClass,
    data: JByteArray,
) -> jstring {
    let bytes = match env.convert_byte_array(&data) {
        Ok(b) => b,
        Err(e) => return throw_and_default(&mut env, &format!("bad data array: {e}")),
    };
    run_json(&mut env, move || {
        let mut backend = barretenberg_rs::api::BarretenbergApi::new(
            barretenberg_rs::backends::FfiBackend::new().map_err(|e| e.to_string())?,
        );
        let resp = backend.blake2s(&bytes).map_err(|e| e.to_string())?;
        Ok(json!({ "hash": hex(&resp.hash) }))
    })
}
