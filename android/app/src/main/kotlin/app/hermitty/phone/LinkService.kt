package app.hermitty.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * Usługa pierwszoplanowa trzymająca połączenie. Uruchomiona z otwartej aplikacji ma też typ „microphone”,
 * dzięki czemu dyktafon da się włączyć zdalnie przy zablokowanym ekranie. Po restarcie telefonu startuje
 * bez mikrofonu (Android 14+ nie pozwala go włączyć w tle), aż użytkownik raz otworzy aplikację.
 */
class LinkService : Service() {
    companion object {
        private const val CH = "link"
        private const val ID = 1
        const val FROM_UI = "ui"

        @Volatile var micReady = false; private set
        @Volatile private var inst: LinkService? = null

        fun start(ctx: Context, fromUi: Boolean) {
            if (Store.apply { init(ctx) }.pairing() == null) return
            ctx.startForegroundService(Intent(ctx, LinkService::class.java).putExtra(FROM_UI, fromUi))
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, LinkService::class.java))

        /** Odświeża treść powiadomienia (stan połączenia, nagrywanie). */
        fun refresh(ctx: Context) { inst?.update() }
    }

    private var offLink: (() -> Unit)? = null
    private var lastBattery = -1 to false

    // Odblokowanie ekranu: dobry moment na próbę połączenia, gdy telefon spał.
    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = Link.wakeUp()
    }

    private val battery = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val b = Info.battery(c)
            if (b != lastBattery) { lastBattery = b; Link.event("info", Info.get(c)) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        inst = this
        Store.init(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH, "Połączenie z komputerem", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        )
        offLink = Link.onChange { update() }
        registerReceiver(battery, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        registerReceiver(screen, IntentFilter(Intent.ACTION_SCREEN_ON).apply { addAction(Intent.ACTION_USER_PRESENT) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val fromUi = intent?.getBooleanExtra(FROM_UI, false) == true
        val wantMic = fromUi && Info.granted(this, android.Manifest.permission.RECORD_AUDIO)
        try {
            if (wantMic) {
                startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                micReady = true
            } else if (!micReady) {
                startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            }
        } catch (e: Exception) {
            micReady = false
            runCatching { startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) }
        }
        update()
        Link.start(this)
        return START_STICKY
    }

    override fun onDestroy() {
        inst = null
        micReady = false
        offLink?.invoke()
        runCatching { unregisterReceiver(battery) }
        runCatching { unregisterReceiver(screen) }
        super.onDestroy()
    }

    private fun build(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val text = when {
            Recorder.recording -> "Nagrywanie dyktafonu…"
            Link.state == Link.State.ONLINE -> "Połączono z ${Link.pcName}" + if (micReady) "" else " · otwórz, by włączyć zdalny dyktafon"
            Link.state == Link.State.CONNECTING -> "Łączenie z ${Link.pcName}…"
            Link.state == Link.State.UNPAIRED -> "Nie sparowano z komputerem"
            else -> "Czekam na ${Link.pcName.ifBlank { "komputer" }}"
        }
        return Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Hermitty")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun update() {
        getSystemService(NotificationManager::class.java).notify(ID, build())
    }
}

/** Po restarcie telefonu i po aktualizacji aplikacji: połączenie wraca samo (bez mikrofonu). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        runCatching { LinkService.start(ctx, fromUi = false) }
    }
}
