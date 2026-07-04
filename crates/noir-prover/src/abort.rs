//! Cooperative abort flag for the ClientIVC prove flow.
//!
//! A single global flag, set from outside (the JNI `requestAbort` entrypoint,
//! called on the RN host's cancel) and observed by `chonk_prove_flow` at
//! circuit-accumulation boundaries. The prover holds a global mutex for the
//! duration of a prove, so the abort caller cannot touch the prover itself —
//! this independent flag is how a cancel reaches an in-flight prove.
//!
//! HONEST SCOPE: abort is cooperative and lands at the NEXT boundary between
//! circuit accumulations. Each individual barretenberg call (a single
//! `chonk_load`/`chonk_accumulate`, and the final `chonk_prove`) is a foreign
//! call with no cancellation token, so it always runs to completion. Cancelling
//! during the final Chonk prove step therefore only takes effect once that step
//! returns. What this buys: a multi-circuit accumulation (the bulk of wall time
//! for heavy flows like the 14-circuit AMM add-liquidity) stops early and frees
//! its memory, rather than always running every remaining circuit.

use std::sync::atomic::{AtomicBool, Ordering};

static ABORT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Request that the in-flight prove stop at its next boundary.
pub fn request_abort() {
    ABORT_REQUESTED.store(true, Ordering::SeqCst);
}

/// Clear the flag. Called at the start of each prove so a stale request from a
/// previous (already-finished) flow cannot cancel a fresh one.
pub fn clear_abort() {
    ABORT_REQUESTED.store(false, Ordering::SeqCst);
}

/// Whether an abort has been requested.
pub fn is_aborted() -> bool {
    ABORT_REQUESTED.load(Ordering::SeqCst)
}
