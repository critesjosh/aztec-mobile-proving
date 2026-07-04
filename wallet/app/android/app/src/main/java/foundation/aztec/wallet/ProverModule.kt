package foundation.aztec.wallet

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import foundation.aztec.noirprover.NativeProver

/**
 * RN native module `Prover` bridging JS <-> the native ClientIVC prover
 * (libnoir_prover_jni.so). The WebView-hosted PXE posts execution steps to the
 * RN host; we prove on-device and hand back the flat proof fields + vk as JSON.
 *
 * Same proven bridge as the rn-spike; old-arch ReactContextBaseJavaModule
 * (JSI/TurboModule is a deferred optimization — bridge cost measured ~0.3%).
 * Heavy work runs on a background thread so the JS/UI thread stays responsive.
 */
class ProverModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "Prover"

    /** Load SRS slices from bundled assets into bb's global CRS store. */
    @ReactMethod
    fun initSrs(promise: Promise) {
        Thread {
            try {
                val g1 = readAsset("srs/bn254_g1.dat")
                val g2 = readAsset("srs/bn254_g2.dat")
                val grumpkin = readAsset("srs/grumpkin_g1.dat")
                val res = NativeProver.initSrs(g1, g2, grumpkin)
                promise.resolve(res)
            } catch (e: Throwable) {
                promise.reject("initSrs", e.message, e)
            }
        }.start()
    }

    /**
     * Prove a base64-encoded ivc-inputs.msgpack (PrivateExecutionStep[]).
     * Returns the chonkProve JSON (verified, proof_fields[], vk, timings,
     * peak_rss_mb).
     */
    @ReactMethod
    fun chonkProve(ivcInputsB64: String, promise: Promise) {
        Thread {
            try {
                val ivc = Base64.decode(ivcInputsB64, Base64.DEFAULT)
                val res = NativeProver.chonkProve(ivc)
                promise.resolve(res)
            } catch (e: Throwable) {
                promise.reject("chonkProve", e.message, e)
            }
        }.start()
    }

    /**
     * Best-effort cancel of an in-flight prove. Runs on its own thread (the
     * prove thread is busy in native code); the native call only sets an atomic
     * flag, so it returns immediately. Cancel lands at the next circuit boundary
     * (the final Chonk prove step still completes) — honest limitation.
     */
    @ReactMethod
    fun requestAbort(promise: Promise) {
        Thread {
            try {
                promise.resolve(NativeProver.requestAbort())
            } catch (e: Throwable) {
                promise.reject("requestAbort", e.message, e)
            }
        }.start()
    }

    private fun readAsset(path: String): ByteArray {
        ctx.assets.open(path).use { return it.readBytes() }
    }
}
