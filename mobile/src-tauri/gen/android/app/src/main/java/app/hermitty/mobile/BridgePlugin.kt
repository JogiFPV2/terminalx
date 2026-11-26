package app.hermitty.mobile

// Mostek z Hermitty na komputerze (dawna osobna aplikacja „Hermitty Telefon”, kod w pakiecie bridge):
// powiadomienia, SMS-y, zdalny dyktafon i dzwonek. Ta wtyczka daje interfejsowi (Svelte) to, co dawał
// stary ekran: stan, wyszukiwanie komputera, parowanie kodem, uprawnienia, dyktafon i ustawienia.
// Wołana z Rusta (src/bridge.rs) jedną komendą `bridge` z nazwą metody.

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.hermitty.mobile.bridge.Info
import app.hermitty.mobile.bridge.Link
import app.hermitty.mobile.bridge.LinkService
import app.hermitty.mobile.bridge.NotifService
import app.hermitty.mobile.bridge.Recorder
import app.hermitty.mobile.bridge.Store
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

@TauriPlugin
class BridgePlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  /** Link z kodu QR (hermitty://pair) czekający na interfejs. */
  private var pending: JSONObject? = null

  override fun load(webView: WebView) {
    Link.init(activity)
    takeLink(activity.intent)
    // Otwarta aplikacja może włączyć usługę z mikrofonem: dyktafon działa wtedy także przy blokadzie ekranu.
    runCatching { LinkService.start(activity, fromUi = true) }
    Link.onChange { main.post { trigger("change", JSObject()) } }
  }

  override fun onNewIntent(intent: Intent) {
    if (takeLink(intent)) trigger("link", JSObject(pending.toString()))
  }

  override fun onResume(activity: AppCompatActivity) {
    runCatching { LinkService.start(activity, fromUi = true) }
    trigger("change", JSObject())
  }

  private fun takeLink(i: Intent?): Boolean {
    val u = i?.data ?: return false
    if (u.scheme != "hermitty" || u.host != "pair") return false
    pending = JSONObject()
      .put("code", u.getQueryParameter("c") ?: "")
      .put("hosts", JSONArray((u.getQueryParameter("h") ?: "").split(',').filter { it.isNotBlank() }))
      .put("port", u.getQueryParameter("p")?.toIntOrNull() ?: Link.DEFAULT_PORT)
    return true
  }

  private fun ok(invoke: Invoke, v: Any? = null) {
    val o = JSObject()
    o.put("v", v ?: JSONObject.NULL)
    invoke.resolve(o)
  }

  /** Praca sieciowa poza wątkiem UI; wyjątek wraca jako czytelny błąd. */
  private fun bg(invoke: Invoke, work: () -> Any?) {
    Thread {
      try { val v = work(); main.post { ok(invoke, v) } }
      catch (e: Exception) { main.post { invoke.reject(e.message ?: e.javaClass.simpleName) } }
    }.start()
  }

  private fun granted(p: String) = Info.granted(activity, p)

  @Command
  fun status(invoke: Invoke) {
    val p = Store.pairing()
    val rec = Recorder.status()
    val o = JSONObject()
      .put("paired", p != null)
      .put("pcName", p?.pcName ?: "")
      .put("hosts", JSONArray(p?.hosts ?: emptyList<String>()))
      .put("state", if (p == null) "unpaired" else Link.state.name.lowercase())
      .put("error", Link.error ?: JSONObject.NULL)
      .put("micReady", LinkService.micReady)
      .put("perms", JSONObject()
        .put("post", Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS))
        .put("notifications", Info.notifAccess(activity))
        .put("sms", granted(Manifest.permission.READ_SMS) && granted(Manifest.permission.SEND_SMS))
        .put("mic", granted(Manifest.permission.RECORD_AUDIO))
        .put("battery", Info.batteryFree(activity))
        .put("lan", !MainActivity.needsLocalNetwork() || granted(MainActivity.LOCAL_NETWORK)))
      .put("showCodes", Store.showCodes)
      .put("autoSend", Store.autoSend)
      .put("recording", Recorder.recording)
      .put("secs", rec.optLong("secs"))
      .put("recordings", if (p != null) Recorder.list(activity) else JSONArray())
      .put("link", pending ?: JSONObject.NULL)
      .put("device", Link.deviceName())
    ok(invoke, o)
  }

  /**
   * Komputery z Hermitty (zdalny dostęp) w tej sieci: pytanie rozgłoszeniowe UDP na porcie zdalnego dostępu,
   * odpowiedź z nazwą, stałym id komputera i portem (remote.rs). Bez kodu QR: telefon sam znajduje komputer,
   * także gdy ten zmienił adres IP.
   */
  @Command
  fun scan(invoke: Invoke) {
    val port = invoke.getArgs().optInt("port", 7420)
    bg(invoke) {
      val found = linkedMapOf<String, JSONObject>()
      DatagramSocket().use { s ->
        s.broadcast = true
        s.soTimeout = 250
        val msg = "HERMITTY-REMOTE?".toByteArray()
        val targets = mutableSetOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        runCatching {
          for (ni in NetworkInterface.getNetworkInterfaces()) {
            if (!ni.isUp || ni.isLoopback) continue
            for (ia in ni.interfaceAddresses) ia.broadcast?.let { targets += it }
          }
        }
        val end = System.currentTimeMillis() + 1600
        var nextSend = 0L
        val buf = ByteArray(2048)
        while (System.currentTimeMillis() < end) {
          // Trzy rundy pytań (pierwszy pakiet bywa gubiony, zanim Wi-Fi się obudzi).
          if (System.currentTimeMillis() >= nextSend) {
            for (t in targets) runCatching { s.send(DatagramPacket(msg, msg.size, t, port)) }
            nextSend = System.currentTimeMillis() + 500
          }
          try {
            val p = DatagramPacket(buf, buf.size)
            s.receive(p)
            val o = runCatching { JSONObject(String(p.data, 0, p.length)) }.getOrNull() ?: continue
            if (o.optString("t") != "hermitty-remote") continue
            val host = p.address.hostAddress ?: continue
            found["${o.optString("id")}|$host"] = JSONObject()
              .put("id", o.optString("id")).put("name", o.optString("name", "Komputer"))
              .put("host", host).put("port", o.optInt("port", port))
          } catch (e: SocketTimeoutException) { /* następna runda */ }
        }
      }
      JSONArray(found.values.toList())
    }
  }

  @Command
  fun discover(invoke: Invoke) = bg(invoke) {
    JSONArray(Link.discover().map { JSONObject().put("id", it.id).put("name", it.name).put("host", it.host).put("port", it.port) })
  }

  @Command
  fun pair(invoke: Invoke) {
    val a = invoke.getArgs()
    val hosts = a.optJSONArray("hosts")?.let { arr -> (0 until arr.length()).map { arr.getString(it) } } ?: emptyList()
    val port = a.optInt("port", Link.DEFAULT_PORT)
    val code = a.optString("code")
    if (hosts.isEmpty() || code.isBlank()) { invoke.reject("Podaj adres komputera i kod."); return }
    bg(invoke) {
      var err: Exception? = null
      for (h in hosts) {
        try { Link.pair(activity, h, port, code); err = null; break } catch (e: Exception) { err = e }
      }
      err?.let { throw it }
      pending = null
      main.post { runCatching { LinkService.start(activity, fromUi = true) } }
      Link.pcName
    }
  }

  @Command
  fun unpair(invoke: Invoke) {
    Link.unpair()
    LinkService.stop(activity)
    ok(invoke)
  }

  @Command
  fun kick(invoke: Invoke) { Link.kick(); ok(invoke) }

  @Command
  fun dismiss(invoke: Invoke) { pending = null; ok(invoke) }

  @Command
  fun settings(invoke: Invoke) {
    val a = invoke.getArgs()
    if (a.has("showCodes")) Store.showCodes = a.getBoolean("showCodes")
    if (a.has("autoSend")) Store.autoSend = a.getBoolean("autoSend")
    ok(invoke)
  }

  private fun openSettings(action: String, uri: Uri? = null) {
    runCatching { activity.startActivity(Intent(action).apply { if (uri != null) data = uri }) }
      .onFailure { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))) }
  }

  /** Prośba o uprawnienie albo otwarcie właściwego ekranu ustawień Androida. */
  @Command
  fun perm(invoke: Invoke) {
    when (invoke.getArgs().optString("kind")) {
      "lan" -> if (MainActivity.needsLocalNetwork()) {
        // Po odmowie z „Nie pytaj ponownie” system nie pokaże okna: wtedy ekran uprawnień aplikacji.
        if (!granted(MainActivity.LOCAL_NETWORK) && !activity.shouldShowRequestPermissionRationale(MainActivity.LOCAL_NETWORK) && Store.lanAsked) openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
        else { Store.lanAsked = true; activity.requestPermissions(arrayOf(MainActivity.LOCAL_NETWORK), 62) }
      }
      "post" -> if (Build.VERSION.SDK_INT >= 33) activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
      "sms" -> activity.requestPermissions(arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS), 42)
      "mic" -> activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 43)
      "notifications" -> {
        val detail = Build.VERSION.SDK_INT >= 30 && runCatching {
          activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(activity, NotifService::class.java).flattenToString()))
        }.isSuccess
        if (!detail) openSettings(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      }
      "battery" -> openSettings(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
      else -> openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
    }
    ok(invoke)
  }

  @Command
  fun rec(invoke: Invoke) {
    val a = invoke.getArgs()
    val name = File(a.optString("name")).name
    bg(invoke) {
      when (a.optString("action")) {
        "toggle" -> if (Recorder.recording) Recorder.stop(activity) else Recorder.start(activity)
        "send" -> {
          val f = File(Recorder.dir(activity), name)
          if (!f.exists()) throw IllegalStateException("Nie ma takiego nagrania.")
          Recorder.send(activity, f)
        }
        "delete" -> { Recorder.delete(activity, name); true }
        else -> throw IllegalArgumentException("Nieznana akcja")
      }
    }
  }
}
