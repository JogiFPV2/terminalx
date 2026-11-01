package app.hermitty.phone

import android.util.Base64
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Ten sam protokół co src-tauri/src/phone.rs: ramki z 4-bajtową długością, AES-256-GCM z kluczem sesji
 * HMAC-SHA256(klucz, kierunek ‖ wyzwanie komputera ‖ wyzwanie telefonu) i licznikiem ramek w nonce.
 */
object Crypto {
    private const val MAX_FRAME = 8 * 1024 * 1024
    private val rng = SecureRandom()

    fun random(n: Int) = ByteArray(n).also { rng.nextBytes(it) }
    fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    fun unb64(s: String): ByteArray = Base64.decode(s, Base64.DEFAULT)

    /** Klucz z jednorazowego kodu parowania (bez myślników, wielkie litery). */
    fun pairKey(code: String): ByteArray {
        val norm = code.filter { it.isLetterOrDigit() }.uppercase()
        val spec = PBEKeySpec(norm.toCharArray(), "hermitty-phone-pair-v1".toByteArray(), 120_000, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    fun sessionKey(base: ByteArray, label: String, cs: ByteArray, cc: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(base, "HmacSHA256"))
        mac.update(label.toByteArray())
        mac.update(cs)
        mac.update(cc)
        return mac.doFinal()
    }

    /** Jeden kierunek kanału. Licznik rośnie z każdą ramką, więc powtórzona albo przestawiona ramka nie przejdzie. */
    class Dir(key: ByteArray) {
        private val k = SecretKeySpec(key, "AES")
        private var n = 0L

        private fun nonce(): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(n).array()

        fun seal(plain: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, k, GCMParameterSpec(128, nonce()))
            n++
            return c.doFinal(plain)
        }

        fun open(frame: ByteArray): ByteArray? = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, nonce()))
            c.doFinal(frame).also { n++ }
        } catch (e: Exception) {
            null
        }
    }

    fun readFrame(inp: DataInputStream): ByteArray {
        val len = inp.readInt()
        if (len < 0 || len > MAX_FRAME) throw IOException("za duża ramka")
        return ByteArray(len).also { inp.readFully(it) }
    }

    fun writeFrame(out: DataOutputStream, data: ByteArray) {
        out.writeInt(data.size)
        out.write(data)
        out.flush()
    }
}
