package app.hermitty.phone

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Sparowany komputer. Klucz urządzenia leży zaszyfrowany kluczem z Android Keystore (nie wychodzi z telefonu). */
data class Pairing(val deviceId: String, val pcId: String, val pcName: String, val hosts: List<String>, val port: Int, val key: ByteArray)

object Store {
    private const val KS_ALIAS = "hermitty-link"
    private lateinit var prefs: SharedPreferences

    fun init(ctx: Context) {
        if (!::prefs.isInitialized) prefs = ctx.applicationContext.getSharedPreferences("link", Context.MODE_PRIVATE)
    }

    /* ---------- ustawienia ---------- */

    /** Kody jednorazowe (SMS, powiadomienia) wysyłane na komputer bez maskowania. */
    var showCodes: Boolean
        get() = prefs.getBoolean("showCodes", false)
        set(v) = prefs.edit().putBoolean("showCodes", v).apply()

    /** Nagrania dyktafonu same trafiają na komputer po zatrzymaniu. */
    var autoSend: Boolean
        get() = prefs.getBoolean("autoSend", true)
        set(v) = prefs.edit().putBoolean("autoSend", v).apply()

    var sent: Set<String>
        get() = prefs.getStringSet("sent", emptySet()) ?: emptySet()
        set(v) = prefs.edit().putStringSet("sent", v).apply()

    fun markSent(name: String) { sent = sent + name }

    /* ---------- parowanie ---------- */

    fun pairing(): Pairing? {
        val id = prefs.getString("device", null) ?: return null
        val key = prefs.getString("key", null)?.let { unwrap(it) } ?: return null
        return Pairing(
            id,
            prefs.getString("pc", "") ?: "",
            prefs.getString("pcName", "Komputer") ?: "Komputer",
            (prefs.getString("hosts", "") ?: "").split(',').filter { it.isNotBlank() },
            prefs.getInt("port", 47390),
            key,
        )
    }

    fun savePairing(p: Pairing) {
        prefs.edit()
            .putString("device", p.deviceId).putString("pc", p.pcId).putString("pcName", p.pcName)
            .putString("hosts", p.hosts.distinct().joinToString(",")).putInt("port", p.port)
            .putString("key", wrap(p.key)).apply()
    }

    /** Ostatni działający adres na początek listy. */
    fun rememberHost(host: String, port: Int) {
        val hosts = listOf(host) + (prefs.getString("hosts", "") ?: "").split(',').filter { it.isNotBlank() && it != host }
        prefs.edit().putString("hosts", hosts.take(6).joinToString(",")).putInt("port", port).apply()
    }

    fun setPcName(name: String) = prefs.edit().putString("pcName", name).apply()

    fun forget() {
        prefs.edit().remove("device").remove("pc").remove("pcName").remove("hosts").remove("key").apply()
    }

    /* ---------- Keystore ---------- */

    private fun ksKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KS_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun wrap(plain: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, ksKey())
        return Crypto.b64(c.iv) + ":" + Crypto.b64(c.doFinal(plain))
    }

    private fun unwrap(s: String): ByteArray? = try {
        val (iv, ct) = s.split(':')
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, ksKey(), GCMParameterSpec(128, Crypto.unb64(iv)))
        c.doFinal(Crypto.unb64(ct))
    } catch (e: Exception) {
        null
    }
}
