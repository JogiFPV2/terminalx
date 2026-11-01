package app.hermitty.phone

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject

/** Stan telefonu dla komputera: bateria, wersja, uprawnienia i gotowość dyktafonu. */
object Info {
    fun granted(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    fun notifAccess(ctx: Context): Boolean {
        val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(ctx, NotifService::class.java).flattenToString()
        return flat.split(':').any { it == me }
    }

    fun batteryFree(ctx: Context) = ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)

    fun perms(ctx: Context) = JSONObject()
        .put("sms", granted(ctx, Manifest.permission.READ_SMS) && granted(ctx, Manifest.permission.SEND_SMS))
        .put("contacts", granted(ctx, Manifest.permission.READ_CONTACTS))
        .put("mic", granted(ctx, Manifest.permission.RECORD_AUDIO))
        .put("notifications", notifAccess(ctx))
        .put("battery", batteryFree(ctx))

    fun battery(ctx: Context): Pair<Int, Boolean> {
        val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return -1 to false
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
        val plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        return (level * 100 / scale) to plugged
    }

    fun get(ctx: Context): JSONObject {
        val (level, charging) = battery(ctx)
        val app = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: ""
        return JSONObject()
            .put("battery", level).put("charging", charging)
            .put("android", Build.VERSION.RELEASE).put("app", app)
            .put("perms", perms(ctx))
            .put("mic", LinkService.micReady)
            .put("rec", Recorder.status())
    }
}
