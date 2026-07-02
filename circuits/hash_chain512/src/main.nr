// Proves knowledge of a secret whose 512-fold poseidon2 permutation chain
// equals a public digest. A non-trivial UltraHonk workload for the on-device
// proving benchmark.
use std::hash::poseidon2_permutation;

global CHAIN_LENGTH: u32 = 512;

fn main(secret: Field, salt: pub Field) -> pub Field {
    let mut state = [secret, salt, 0, 0];
    for _ in 0..CHAIN_LENGTH {
        state = poseidon2_permutation(state);
    }
    state[0]
}
