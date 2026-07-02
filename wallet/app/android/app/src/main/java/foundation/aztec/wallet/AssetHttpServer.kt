package foundation.aztec.wallet

import android.content.res.AssetManager
import android.util.Log
import java.io.BufferedReader
import java.io.FileNotFoundException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Minimal loopback HTTP server that serves the bundled WebView PXE assets
 * (the assets/pxe directory) so the PXE runs from the stable secure origin
 * `http://127.0.0.1:PORT` instead of `file://`:
 *
 *  - stable origin => IndexedDB persistence for the PXE data store;
 *  - secure context => `crypto.subtle`, OPFS availability (probed, not assumed);
 *  - real ES-module + Worker loading, so the 67 MB single-file inlining the
 *    spike needed over file:// is unnecessary.
 *
 * Security posture (documented in wallet/PLAN.md): binds strictly to
 * 127.0.0.1, serves ONLY static public app assets under one directory (GET/
 *  HEAD, no directory listing, path-traversal rejected). No secret material
 * ever transits HTTP — the wallet RPC and prove bridge stay on postMessage.
 * The port is FIXED because origin = scheme+host+port; a different port would
 * silently orphan the persisted IndexedDB state, so a failed bind is a hard
 * error surfaced to JS rather than a fallback.
 */
class AssetHttpServer(
    private val assets: AssetManager,
    private val port: Int,
    private val rootDir: String,
) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(4)

    companion object {
        private const val TAG = "AssetHttpServer"
        private const val MAX_HEADERS = 64
        private const val MAX_LINE_BYTES = 8192
        private val MIME = mapOf(
            "html" to "text/html; charset=utf-8",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "map" to "application/json",
            "wasm" to "application/wasm",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "ico" to "image/x-icon",
            "dat" to "application/octet-stream",
            "gz" to "application/gzip",
            "msgpack" to "application/octet-stream",
        )
    }

    val origin: String get() = "http://127.0.0.1:$port"

    /** Bind and start accepting. Throws on bind failure (fixed-port policy). */
    @Synchronized
    fun start() {
        if (running.get()) return
        // Explicit IPv4: getLoopbackAddress() can return ::1, and the WebView
        // dials 127.0.0.1 (observed ERR_CONNECTION_REFUSED on the emulator).
        val socket = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
        serverSocket = socket
        running.set(true)
        Thread({
            while (running.get()) {
                try {
                    val client = socket.accept()
                    pool.execute { handle(client) }
                } catch (e: Throwable) {
                    if (running.get()) Log.w(TAG, "accept failed: ${e.message}")
                }
            }
        }, "asset-http-accept").start()
        Log.i(TAG, "serving $rootDir at $origin")
    }

    private fun handle(client: Socket) {
        client.use { sock ->
            try {
                sock.soTimeout = 10_000
                val reader = BufferedReader(InputStreamReader(sock.getInputStream(), Charsets.US_ASCII))
                val requestLine = readBoundedLine(reader) ?: return
                // Drain headers (we don't need them), with hard caps so a
                // misbehaving local client can't pin a worker on an endless
                // header stream. (Residual: loopback slowloris within the
                // caps can briefly occupy workers — local-only, self-healing,
                // and only delays static asset loads.)
                var headerCount = 0
                while (headerCount++ < MAX_HEADERS) {
                    val line = readBoundedLine(reader) ?: break
                    if (line.isEmpty()) break
                }
                val parts = requestLine.split(" ")
                if (parts.size < 2) return respond(sock, 400, "Bad Request", null, "text/plain", false)
                val method = parts[0]
                if (method != "GET" && method != "HEAD") {
                    return respond(sock, 405, "Method Not Allowed", null, "text/plain", false)
                }
                val rawPath = parts[1].substringBefore('?').substringBefore('#')
                val path = normalize(rawPath) ?: return respond(sock, 403, "Forbidden", null, "text/plain", false)
                val body = try {
                    assets.open("$rootDir/$path").use { it.readBytes() }
                } catch (e: FileNotFoundException) {
                    return respond(sock, 404, "Not Found", null, "text/plain", false)
                }
                val ext = path.substringAfterLast('.', "")
                val mime = MIME[ext] ?: "application/octet-stream"
                respond(sock, 200, "OK", body, mime, method == "HEAD")
            } catch (e: Throwable) {
                Log.w(TAG, "request failed: ${e.message}")
            }
        }
    }

    /** Read a CRLF/LF-terminated line of at most MAX_LINE_BYTES; null on EOF/overflow. */
    private fun readBoundedLine(reader: BufferedReader): String? {
        val sb = StringBuilder()
        while (true) {
            val c = reader.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
            if (sb.length > MAX_LINE_BYTES) return null
        }
    }

    /** Resolve the URL path to a safe relative asset path, or null if unsafe. */
    private fun normalize(rawPath: String): String? {
        var p = rawPath
        if (!p.startsWith("/")) return null
        p = p.removePrefix("/")
        if (p.isEmpty()) p = "index.html"
        // Reject traversal, backslashes, absolute tricks, and encoded dots.
        if (p.contains("..") || p.contains('\\') || p.contains("%")) return null
        return p
    }

    private fun respond(sock: Socket, code: Int, reason: String, body: ByteArray?, mime: String, headOnly: Boolean) {
        val payload = body ?: reason.toByteArray()
        val headers = StringBuilder()
            .append("HTTP/1.1 $code $reason\r\n")
            .append("Content-Type: $mime\r\n")
            .append("Content-Length: ${payload.size}\r\n")
            .append("Cache-Control: no-store\r\n")
            .append("Connection: close\r\n")
            .append("\r\n")
        val out = sock.getOutputStream()
        out.write(headers.toString().toByteArray(Charsets.US_ASCII))
        if (!headOnly) out.write(payload)
        out.flush()
    }

    @Synchronized
    fun stop() {
        running.set(false)
        try {
            serverSocket?.close()
        } catch (_: Throwable) {}
        serverSocket = null
    }
}
