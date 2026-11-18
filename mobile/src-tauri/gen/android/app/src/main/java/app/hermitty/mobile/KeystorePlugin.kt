package app.hermitty.mobile

// Sejf na sekrety telefonu: klucze sparowanych komputerów, klucz API dostawcy AI, hasła SSH.
// Klucz AES-256-GCM żyje w Android Keystore (nie da się go wyjąć z telefonu), a w SharedPreferences
// leżą tylko zaszyfrowane wartości (IV + szyfrogram, base64). Wywoływany z Rusta (src/secret.rs).

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class KeyArgs {
  lateinit var name: String
}

@InvokeArg
class SetArgs {
  lateinit var name: String
  lateinit var value: String
}

@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
  private val alias = "hermitty-secrets"
  private val prefs by lazy { activity.getSharedPreferences("hermitty-secrets", Context.MODE_PRIVATE) }

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  private fun seal(plain: String): String {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(out, Base64.NO_WRAP)
  }

  private fun open(sealed: String): String {
    val raw = Base64.decode(sealed, Base64.NO_WRAP)
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
    return String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
  }

  @Command
  fun get(invoke: Invoke) {
    val args = invoke.parseArgs(KeyArgs::class.java)
    val ret = JSObject()
    try {
      val s = prefs.getString(args.name, null)
      ret.put("value", if (s == null) null else open(s))
      invoke.resolve(ret)
    } catch (e: Exception) {
      // Klucz w Keystore przepadł (np. reset zabezpieczeń telefonu): wartości nie da się odczytać.
      prefs.edit().remove(args.name).apply()
      ret.put("value", null)
      invoke.resolve(ret)
    }
  }

  @Command
  fun set(invoke: Invoke) {
    val args = invoke.parseArgs(SetArgs::class.java)
    try {
      prefs.edit().putString(args.name, seal(args.value)).commit()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("Nie udało się zapisać sekretu: ${e.message}")
    }
  }

  @Command
  fun delete(invoke: Invoke) {
    val args = invoke.parseArgs(KeyArgs::class.java)
    prefs.edit().remove(args.name).commit()
    invoke.resolve()
  }
}
