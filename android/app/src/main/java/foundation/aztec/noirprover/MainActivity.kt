package foundation.aztec.noirprover

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var log: TextView
    private lateinit var buttons: List<Button>
    @Volatile private var srsReady = false

    private data class Flow(val label: String, val asset: String)

    private val flows = listOf(
        Flow("Account deployment (ecdsa_r1)", "flows/account_deploy.msgpack"),
        Flow("Private token transfer", "flows/token_transfer.msgpack"),
        Flow("AMM add liquidity", "flows/amm_add_liquidity.msgpack"),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
        }

        val title = TextView(this).apply {
            text = "Aztec on-device proving (bb v5.0.0-rc.2)"
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
        }
        root.addView(title)

        val flowButtons = flows.map { flow ->
            Button(this).apply {
                text = "Prove: ${flow.label}"
                isEnabled = false
                setOnClickListener { runChonkFlow(flow) }
            }
        }
        val ultraButton = Button(this).apply {
            text = "Prove: hash-chain 512 (UltraHonk)"
            isEnabled = false
            setOnClickListener { runUltraHonk() }
        }
        buttons = flowButtons + ultraButton
        buttons.forEach { root.addView(it) }

        log = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setTextIsSelectable(true)
        }
        val scroll = ScrollView(this).apply {
            addView(log)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        root.addView(scroll)
        setContentView(root)

        appendLog("loading SRS + native library...")
        thread {
            try {
                val smoke = NativeProver.blake2s("hello".toByteArray())
                appendLog("bbapi smoke: $smoke")
                val g1 = assets.open("srs/bn254_g1.dat").readBytes()
                val g2 = assets.open("srs/bn254_g2.dat").readBytes()
                val grumpkin = assets.open("srs/grumpkin_g1.dat").readBytes()
                val t = System.currentTimeMillis()
                val res = NativeProver.initSrs(g1, g2, grumpkin)
                appendLog("srs init in ${System.currentTimeMillis() - t} ms: $res")
                srsReady = true
                runOnUiThread { buttons.forEach { it.isEnabled = true } }
            } catch (e: Exception) {
                appendLog("SRS INIT FAILED: ${e.message}")
            }
        }
    }

    private fun runChonkFlow(flow: Flow) {
        setBusy(true)
        appendLog("\n=== ${flow.label} ===")
        thread {
            try {
                val inputs = assets.open(flow.asset).readBytes()
                appendLog("ivc inputs: ${inputs.size / 1024} KB")
                val t = System.currentTimeMillis()
                val result = NativeProver.chonkProve(inputs)
                val wall = System.currentTimeMillis() - t
                val json = JSONObject(result)
                val steps = json.getJSONArray("steps")
                for (i in 0 until steps.length()) {
                    val s = steps.getJSONObject(i)
                    appendLog(
                        "  %-55s acc %5d ms".format(
                            s.getString("name"), s.getLong("accumulate_ms")
                        )
                    )
                }
                appendLog("circuits: ${json.getInt("num_circuits")}")
                appendLog("chonk prove: ${json.getLong("prove_ms")} ms | vk: ${json.getLong("vk_ms")} ms | verify: ${json.getLong("verify_ms")} ms")
                appendLog("total: ${json.getLong("total_ms")} ms (wall ${wall} ms)")
                appendLog("proof: ${json.getInt("proof_size_bytes") / 1024} KB | peak rss: ${json.getDouble("peak_rss_mb")} MB")
                appendLog("VERIFIED: ${json.getBoolean("verified")}")
            } catch (e: Exception) {
                appendLog("FAILED: ${e.message}")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun runUltraHonk() {
        setBusy(true)
        appendLog("\n=== hash-chain 512 (UltraHonk) ===")
        thread {
            try {
                val artifact = assets.open("circuits/hash_chain512.json").readBytes()
                val inputs = assets.open("circuits/hash_chain512_inputs.json")
                    .readBytes().decodeToString()
                val result = JSONObject(NativeProver.prove(artifact, inputs))
                appendLog("gates: ${result.optInt("num_gates")} (dyadic ${result.optInt("num_gates_dyadic")})")
                appendLog("witgen: ${result.getLong("witgen_ms")} ms | vk: ${result.getLong("vk_ms")} ms | prove: ${result.getLong("prove_ms")} ms")
                appendLog("proof fields: ${result.getInt("proof_fields")} | peak rss: ${result.getDouble("peak_rss_mb")} MB")
                val verify = JSONObject(NativeProver.verifyLast())
                appendLog("VERIFIED: ${verify.getBoolean("verified")} in ${verify.getLong("verify_ms")} ms")
            } catch (e: Exception) {
                appendLog("FAILED: ${e.message}")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        runOnUiThread { buttons.forEach { it.isEnabled = !busy && srsReady } }
    }

    private fun appendLog(line: String) {
        android.util.Log.i("NoirProver", line)
        runOnUiThread {
            log.append(line + "\n")
            (log.parent as? ScrollView)?.post {
                (log.parent as ScrollView).fullScroll(View.FOCUS_DOWN)
            }
        }
    }
}
