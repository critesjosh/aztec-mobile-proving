package foundation.aztec.wallet

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Starts the loopback asset server for the WebView PXE bundle and hands the
 * origin to JS. A bind failure is a hard error (see AssetHttpServer docs and
 * wallet/PLAN.md fixed-port policy) surfaced to JS for a blocking error screen.
 */
class PxeServerModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "PxeServer"

    companion object {
        // Fixed: the origin (scheme+host+port) keys the persisted IndexedDB state.
        const val PORT = 38271
        private var server: AssetHttpServer? = null
    }

    @ReactMethod
    fun start(promise: Promise) {
        Thread {
            try {
                synchronized(PxeServerModule::class.java) {
                    if (server == null) {
                        val s = AssetHttpServer(ctx.assets, PORT, "pxe")
                        s.start()
                        server = s
                    }
                }
                promise.resolve(server!!.origin)
            } catch (e: Throwable) {
                promise.reject("PxeServer.start", "failed to bind 127.0.0.1:$PORT: ${e.message}", e)
            }
        }.start()
    }
}
