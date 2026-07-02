# Transaction input stacks (`ivc-inputs.msgpack`)

The bundled ClientIVC flow inputs under `android/app/src/main/assets/flows/`
are `ivc-inputs.msgpack` step stacks captured from the aztec-packages
`yarn-project/end-to-end/src/bench/client_flows` benchmark suite at
v5.0.0-rc.2:

| Asset | Source flow | Circuits |
|---|---|---|
| `account_deploy.msgpack` | `deploy_ecdsar1+sponsored_fpc` | 10 |
| `token_transfer.msgpack` | `ecdsar1+transfer_0_recursions+sponsored_fpc` | 7 |
| `amm_add_liquidity.msgpack` | `ecdsar1+amm_add_liquidity_1_recursions+sponsored_fpc` | 14 |

These come from the repo's pinned Chonk-inputs tarball
(`barretenberg/cpp/scripts/chonk_inputs.sh download`), which is the canonical,
CI-verified set.

## Capturing your own (including an AMM swap)

The pinned set has no AMM **swap** flow. To capture one you run the
`client_flows` benchmark with `CAPTURE_IVC_FOLDER` set, which writes an
`ivc-inputs.msgpack` per labeled `captureProfile(...)` call:

```bash
# in an aztec-packages checkout at v5.0.0-rc.2, after building yarn-project:
CAPTURE_IVC_FOLDER=/tmp/flows BENCHMARK_CONFIG=key_flows \
  yarn-project/end-to-end/scripts/run_test.sh simple client_flows/amm
cp /tmp/flows/ecdsar1+amm_swap_1_recursions+sponsored_fpc/ivc-inputs.msgpack \
  android/app/src/main/assets/flows/amm_swap.msgpack
```

A swap `captureProfile` block (calling
`AMM.swap_exact_tokens_for_tokens` after add-liquidity, so the pool has
liquidity) can be added to `amm.test.ts` mirroring the add-liquidity block; the
label determines the output folder name.

Any msgpack of `PrivateExecutionStep[]` (`{bytecode, witness, vk, functionName}`,
bytecode/witness gzipped) works — see `crates/noir-prover/src/chonk.rs`.
