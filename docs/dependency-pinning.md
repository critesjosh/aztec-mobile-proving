# Dependency pinning discipline

This repo proves real Aztec transactions on-device. Proving is exquisitely
sensitive to the *exact* build of every layer that touches a witness or a
circuit artifact: the on-device ACVM (noir crates), the native prover
(barretenberg static lib), and the off-device tooling that produced the bundled
artifacts must all agree byte-for-byte. A mismatch does not fail loudly at build
time. It fails as a witness that silently mis-decodes or a proof that will not
verify.

The rule: **pin by exact commit, never by a floating tag.**

## Why exact commit, not tag

1. **Tags move; commits do not.** A git tag is a mutable pointer. An exact
   commit (`rev`) is content-addressed and immutable.

2. **The toolchain pins noir by submodule commit, not by release tag.** The
   aztec-packages / barretenberg build tracks noir via a git *submodule*. That
   submodule commit routinely carries post-release changes that are NOT in the
   identically-named noir release tag — most dangerously, serialization-format
   changes (ACIR / witness map msgpack-vs-bincode, field encodings). The `bb`
   postprocessor writes artifacts in the *submodule commit's* format. If our
   on-device ACVM is built from the release *tag* instead of that commit, the
   two can disagree on wire format while reporting the same version string, and
   witnesses decode to garbage with no error.

3. **Reproducibility.** An exact commit makes the build reproducible independent
   of what any upstream tag currently points at.

## What is pinned, and to what

| Layer | Where | Pinned to |
|---|---|---|
| noir ACVM crates (`acir`, `acvm`, `bn254_blackbox_solver`, `noirc_abi`) | root `Cargo.toml` `[workspace.dependencies]` | `rev = c57152f91260ecdb9faad4efc20abb14b6d2ece7` (the commit the `v1.0.0-beta.22` tag resolved to; the rev the pinned barretenberg lib was built against) |
| barretenberg static lib | `vendor/barretenberg-rs/build.rs` via `BARRETENBERG_VERSION` | `5.0.0-rc.2` release assets (`libbb-external.a`), integrity noted in `vendor/barretenberg-rs/NOTICE` |
| bundled tx-input artifacts | `android/app/src/main/assets/flows/` | captured at aztec-packages `v5.0.0-rc.2` (see `docs/tx-inputs.md`) |
| `@aztec/*` npm | `wallet/pxe-web/package.json`, `wallet/app/package.json` | `5.0.0-rc.2` exact versions |

The noir crates are only compiled by the optional `ultrahonk` feature
(on-device witgen), but the pin discipline applies regardless: if that feature
is ever enabled in a shipped build, the ACVM must match the artifact producer.

## Verifying the pin

`Cargo.lock` records the resolved commit for every noir-repo crate as
`...noir?rev=<rev>#<rev>`. The `rev` in the query string and the `#`-suffixed
commit must be identical, and must match the `rev` in `Cargo.toml`:

```bash
grep -c 'noir-lang/noir?rev=c57152f91260ecdb9faad4efc20abb14b6d2ece7' Cargo.lock  # all noir crates
grep -c 'noir-lang/noir?tag='                                          Cargo.lock  # must be 0
cargo metadata --format-version 1 >/dev/null                                        # resolves cleanly
```

## On a version bump

When moving to a new aztec-packages / barretenberg release:

1. Resolve the **exact noir submodule commit** the new release was built
   against — read it from the aztec-packages checkout's noir submodule (or the
   barretenberg build metadata), NOT from a noir release tag.
2. Update the four `rev = ...` lines in `Cargo.toml` to that commit and record
   the corresponding tag in the adjacent comment.
3. Update `BARRETENBERG_VERSION` and re-download the static lib.
4. Re-capture the bundled tx-input artifacts at the new version.
5. Re-run `cargo metadata` and rebuild; re-prove all bundled flows and confirm
   `verified: true` before treating the bump as done. A version string match is
   not sufficient evidence — a real prove+verify is.
