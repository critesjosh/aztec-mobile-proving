//! ACVM-based witness generation for a compiled Noir program.

use acir::circuit::Program;
use acir::native_types::{WitnessMap, WitnessStack};
use acir::FieldElement;
use acvm::brillig_vm::brillig::ForeignCallResult;
use acvm::pwg::{ACVMStatus, ACVM};
use bn254_blackbox_solver::Bn254BlackBoxSolver;

use crate::error::{ProverError, Result};

/// Foreign calls that only produce side effects (logging) and can safely be
/// answered with an empty result during on-device execution.
const SIDE_EFFECT_FOREIGN_CALLS: &[&str] = &["print"];

/// Execute a single-function ACIR program and return the solved witness stack.
///
/// Barretenberg's `CircuitProve` only accepts single-function programs, so
/// programs using `#[fold]` / ACIR calls are rejected.
pub fn execute_program(
    program: &Program<FieldElement>,
    initial_witness: WitnessMap<FieldElement>,
) -> Result<WitnessStack<FieldElement>> {
    if program.functions.len() != 1 {
        return Err(ProverError::Witgen(format!(
            "expected a single-function ACIR program, got {} functions",
            program.functions.len()
        )));
    }
    let circuit = &program.functions[0];

    let solver = Bn254BlackBoxSolver;
    let mut acvm = ACVM::new(
        &solver,
        &circuit.opcodes,
        initial_witness,
        &program.unconstrained_functions,
        &circuit.assert_messages,
    );

    loop {
        match acvm.solve() {
            ACVMStatus::Solved => break,
            ACVMStatus::InProgress => continue,
            ACVMStatus::Failure(err) => {
                return Err(ProverError::Witgen(format!("circuit execution failed: {err}")));
            }
            ACVMStatus::RequiresForeignCall(call) => {
                if SIDE_EFFECT_FOREIGN_CALLS.contains(&call.function.as_str()) {
                    acvm.resolve_pending_foreign_call(ForeignCallResult::default());
                } else {
                    return Err(ProverError::Witgen(format!(
                        "unsupported foreign call during witness generation: {}",
                        call.function
                    )));
                }
            }
            ACVMStatus::RequiresAcirCall(_) => {
                return Err(ProverError::Witgen(
                    "ACIR calls (multi-function programs) are not supported".to_string(),
                ));
            }
        }
    }

    let witness_map = acvm.finalize();
    Ok(WitnessStack::from(witness_map))
}
