package foundation.aztec.wallet

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Key custody primitives for the wallet:
 *
 *  - `randomBytes(n)`: cryptographically secure randomness (SecureRandom) for
 *    account secrets/salts/signing keys. Replaces the spike's Math.random.
 *  - `seal`/`unseal`: AES-256-GCM with a key generated in — and never leaving —
 *    the Android Keystore (hardware-backed where the device supports it).
 *    Used to encrypt the account-material blob at rest; the sealed blob is
 *    stored in app-private storage by the JS side.
 *
 * Sealed format (base64): [1-byte version=1][12-byte GCM IV][ciphertext+tag].
 */
class SecureKeysModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "SecureKeys"

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "aztec-wallet-sealing-key-v1"
        private const val VERSION: Byte = 1
        private const val GCM_TAG_BITS = 128
        private const val GCM_IV_BYTES = 12
    }

    @ReactMethod
    fun randomBytes(n: Int, promise: Promise) {
        try {
            require(n in 1..4096) { "randomBytes: n out of range" }
            val bytes = ByteArray(n)
            SecureRandom().nextBytes(bytes)
            promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
        } catch (e: Throwable) {
            promise.reject("randomBytes", e.message, e)
        }
    }

    @ReactMethod
    fun seal(plainB64: String, promise: Promise) {
        Thread {
            try {
                val plain = Base64.decode(plainB64, Base64.NO_WRAP)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
                val iv = cipher.iv
                require(iv.size == GCM_IV_BYTES) { "unexpected GCM IV size ${iv.size}" }
                val ct = cipher.doFinal(plain)
                plain.fill(0)
                val out = ByteArray(1 + iv.size + ct.size)
                out[0] = VERSION
                iv.copyInto(out, 1)
                ct.copyInto(out, 1 + iv.size)
                promise.resolve(Base64.encodeToString(out, Base64.NO_WRAP))
            } catch (e: Throwable) {
                promise.reject("seal", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun unseal(sealedB64: String, promise: Promise) {
        Thread {
            try {
                val sealed = Base64.decode(sealedB64, Base64.NO_WRAP)
                require(sealed.size > 1 + GCM_IV_BYTES) { "sealed blob too short" }
                require(sealed[0] == VERSION) { "unsupported sealed blob version ${sealed[0]}" }
                val iv = sealed.copyOfRange(1, 1 + GCM_IV_BYTES)
                val ct = sealed.copyOfRange(1 + GCM_IV_BYTES, sealed.size)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
                val plain = cipher.doFinal(ct)
                promise.resolve(Base64.encodeToString(plain, Base64.NO_WRAP))
            } catch (e: Throwable) {
                promise.reject("unseal", e.message, e)
            }
        }.start()
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        kg.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return kg.generateKey()
    }
}
