package app.hermitty.mobile

// Termux przez jego API dla innych aplikacji (RUN_COMMAND): Hermitty wysyła komendę do Termuxa i dostaje
// stdout, stderr i kod wyjścia. Tak konfigurujemy w Termuxie serwer SSH (openssh + klucz Hermitty), a potem
// zakładka Termuxa to zwykła sesja SSH na 127.0.0.1:8022 z pełnym, interaktywnym terminalem.
// Wymaga: Termux zainstalowany, uprawnienie com.termux.permission.RUN_COMMAND i allow-external-apps=true
// w ~/.termux/termux.properties (to ostatnie ustawia użytkownik w Termuxie, Android nie pozwala nam).
// Przy okazji: zapis pliku do Pobranych (MediaStore) dla zakładki plików SFTP.

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.atomic.AtomicInteger

@TauriPlugin
class TermuxPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    const val PKG = "com.termux"
    const val PERM = "com.termux.permission.RUN_COMMAND"
    private const val ACTION_RESULT = "app.hermitty.mobile.TERMUX_RESULT"
    private val seq = AtomicInteger(1)
  }

  private val main = Handler(Looper.getMainLooper())

  private fun installed(): Boolean = try {
    activity.packageManager.getPackageInfo(PKG, 0); true
  } catch (e: PackageManager.NameNotFoundException) { false }

  private fun granted() = activity.checkSelfPermission(PERM) == PackageManager.PERMISSION_GRANTED

  @Command
  fun status(invoke: Invoke) {
    val o = JSObject()
    o.put("installed", installed())
    o.put("permission", granted())
    invoke.resolve(o)
  }

  @Command
  fun permission(invoke: Invoke) {
    if (!granted()) activity.requestPermissions(arrayOf(PERM), 51)
    invoke.resolve()
  }

  @Command
  fun open(invoke: Invoke) {
    val i = activity.packageManager.getLaunchIntentForPackage(PKG)
    if (i == null) { invoke.reject("Termux nie jest zainstalowany."); return }
    activity.startActivity(i)
    invoke.resolve()
  }

  /**
   * Komenda w bash Termuxa, w tle. Wynik (stdout, stderr, exitCode) przychodzi przez PendingIntent.
   * `timeoutMs`: ile czekamy na wynik (instalacja pakietów potrafi trwać kilka minut).
   */
  @Command
  fun run(invoke: Invoke) {
    val a = invoke.getArgs()
    val cmd = a.optString("command")
    val timeout = a.optLong("timeoutMs", 60_000L).coerceIn(2_000L, 900_000L)
    if (!installed()) { invoke.reject("Termux nie jest zainstalowany."); return }
    if (!granted()) { invoke.reject("Brak uprawnienia do uruchamiania komend w Termuxie."); return }

    val id = seq.getAndIncrement()
    val action = "$ACTION_RESULT.$id"
    var done = false
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) {
        if (done) return
        done = true
        runCatching { activity.unregisterReceiver(this) }
        val r = intent.getBundleExtra("result")
        val o = JSObject()
        o.put("stdout", r?.getString("stdout") ?: "")
        o.put("stderr", r?.getString("stderr") ?: "")
        o.put("exitCode", r?.getInt("exitCode", -1) ?: -1)
        o.put("err", r?.getInt("err", 0) ?: 0)
        o.put("errmsg", r?.getString("errmsg") ?: "")
        invoke.resolve(o)
      }
    }
    val filter = IntentFilter(action)
    if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else activity.registerReceiver(receiver, filter)

    // Jawny cel (nasz pakiet): na Androidzie 14+ zmienny PendingIntent musi wskazywać konkretną aplikację.
    val result = Intent(action).setPackage(activity.packageName)
    val pi = PendingIntent.getBroadcast(activity, id, result, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
    val intent = Intent()
      .setClassName(PKG, "com.termux.app.RunCommandService")
      .setAction("com.termux.RUN_COMMAND")
      .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
      .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", cmd))
      .putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
      .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
      .putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "Hermitty")
      .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pi)
    try {
      // Hermitty jest na pierwszym planie, więc zwykły startService wystarczy.
      activity.startService(intent)
    } catch (e: Exception) {
      done = true
      runCatching { activity.unregisterReceiver(receiver) }
      invoke.reject("Termux odrzucił komendę: ${e.message}. Sprawdź allow-external-apps=true w ~/.termux/termux.properties.")
      return
    }
    main.postDelayed({
      if (!done) {
        done = true
        runCatching { activity.unregisterReceiver(receiver) }
        invoke.reject("Termux nie odpowiedział. Otwórz raz aplikację Termux i sprawdź allow-external-apps=true w ~/.termux/termux.properties.")
      }
    }, timeout)
  }

  /** Zapisuje plik (base64) w Pobranych przez MediaStore; zwraca ścieżkę do pokazania użytkownikowi. */
  @Command
  fun saveDownload(invoke: Invoke) {
    val a = invoke.getArgs()
    val name = a.optString("name").replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "plik" }
    val data = try { Base64.decode(a.optString("data"), Base64.DEFAULT) } catch (e: Exception) { invoke.reject("Uszkodzone dane"); return }
    try {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Hermitty")
      }
      val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("Brak miejsca w Pobranych")
      activity.contentResolver.openOutputStream(uri)!!.use { it.write(data) }
      val o = JSObject()
      o.put("path", "Pobrane/Hermitty/$name")
      invoke.resolve(o)
    } catch (e: Exception) {
      invoke.reject("Nie udało się zapisać: ${e.message}")
    }
  }
}
