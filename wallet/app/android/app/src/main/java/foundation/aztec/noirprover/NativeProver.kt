package foundation.aztec.noirprover

/**
 * JNI bridge to libnoir_prover_jni.so (Rust: noir-prover-jni crate).
 * All methods return JSON strings and throw RuntimeException on failure.
 */
object NativeProver {
    init {
        System.loadLibrary("noir_prover_jni")
    }

    /** Feed BN254 (+ optional Grumpkin) SRS points. Must be called once before proving. */
    external fun initSrs(g1: ByteArray, g2: ByteArray, grumpkinG1: ByteArray): String

    /** UltraHonk: witgen + prove a compiled Noir program with JSON inputs. */
    external fun prove(artifactJson: ByteArray, inputsJson: String): String

    /** UltraHonk: verify the proof produced by the last [prove] call. */
    external fun verifyLast(): String

    /** ClientIVC: prove + verify a full Aztec tx from an ivc-inputs.msgpack buffer. */
    external fun chonkProve(ivcInputs: ByteArray): String

    /**
     * Cooperatively cancel an in-flight [chonkProve] at its next circuit
     * boundary. Best-effort (the final prove step still runs to completion).
     * Safe to call from another thread during a prove.
     */
    external fun requestAbort(): String

    /** bbapi smoke test. */
    external fun blake2s(data: ByteArray): String
}
