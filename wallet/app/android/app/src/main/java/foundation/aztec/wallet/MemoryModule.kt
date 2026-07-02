package foundation.aztec.wallet

import android.os.Debug
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject
import java.io.File

/**
 * Memory instrumentation for the app process (memory is a first-class,
 * fail-fast concern for this wallet — see wallet/PLAN.md).
 *
 * Reports current PSS (Debug.MemoryInfo) plus current/peak RSS from
 * /proc/self/status (VmRSS / VmHWM). The WebView renderer runs in a separate
 * sandboxed process and is NOT visible from here; the host-side
 * scripts/mem-watch.sh covers it via dumpsys.
 */
class MemoryModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "MemoryInfo"

    @ReactMethod
    fun sample(promise: Promise) {
        try {
            val mi = Debug.MemoryInfo()
            Debug.getMemoryInfo(mi)
            val out = JSONObject()
            out.put("totalPssMb", mi.totalPss / 1024.0)
            out.put("nativeHeapMb", Debug.getNativeHeapAllocatedSize() / 1048576.0)
            procStatusKb("VmRSS")?.let { out.put("vmRssMb", it / 1024.0) }
            procStatusKb("VmHWM")?.let { out.put("peakRssMb", it / 1024.0) }
            promise.resolve(out.toString())
        } catch (e: Throwable) {
            promise.reject("sample", e.message, e)
        }
    }

    /** Parse a kB-valued field from /proc/self/status. */
    private fun procStatusKb(field: String): Long? =
        try {
            File("/proc/self/status").useLines { lines ->
                lines.firstOrNull { it.startsWith("$field:") }
                    ?.substringAfter(':')?.trim()?.removeSuffix(" kB")?.trim()?.toLongOrNull()
            }
        } catch (e: Throwable) {
            null
        }
}
