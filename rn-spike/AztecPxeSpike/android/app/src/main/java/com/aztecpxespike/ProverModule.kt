package com.aztecpxespike

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import foundation.aztec.noirprover.NativeProver
import kotlin.system.measureTimeMillis

/**
 * RN native module `Prover` bridging JS <-> this repo's native ClientIVC prover
 * (libnoir_prover_jni.so). The WebView-hosted PXE posts execution steps here;
 * we prove on-device and hand back the flat proof fields + vk as JSON.
 *
 * Old-arch ReactContextBaseJavaModule (works under RN 0.84 New Arch interop).
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
     * Returns the chonkProve JSON (verified, proof_fields[], vk, timings).
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
     * MEASUREMENT: prove a bundled flow stack (assets/flows/<name>.msgpack) and
     * return the full chonkProve JSON. Isolates native prove + the size of the
     * proof-fields JSON that must cross the bridge, without the WebView. Also
     * reports read/decode timing on the native side.
     */
    @ReactMethod
    fun benchStack(assetPath: String, promise: Promise) {
        Thread {
            try {
                lateinit var ivc: ByteArray
                val readMs = measureTimeMillis { ivc = readAsset(assetPath) }
                lateinit var res: String
                // Wall time of the JNI prove call (native prove + the Rust-side
                // JSON serialization of the ~2630/4133-field result).
                val callWallMs = measureTimeMillis { res = NativeProver.chonkProve(ivc) }
                val out = org.json.JSONObject(res)
                out.put("native_read_ms", readMs)
                out.put("native_call_wall_ms", callWallMs)
                out.put("ivc_bytes", ivc.size)
                val finalJson = out.toString()
                out.put("result_json_bytes", finalJson.toByteArray(Charsets.UTF_8).size)
                promise.resolve(out.toString())
            } catch (e: Throwable) {
                promise.reject("benchStack", e.message, e)
            }
        }.start()
    }

    private fun readAsset(path: String): ByteArray {
        ctx.assets.open(path).use { return it.readBytes() }
    }
}
