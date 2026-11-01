package app.hermitty.phone

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Dyktafon: Opus w kontenerze OGG (~24 kb/s, ok. 11 MB na godzinę), pliki w pamięci aplikacji. */
object Recorder {
    private var rec: MediaRecorder? = null
    private var file: File? = null
    private var started = 0L
    /** Wysyłane pliki czekające na potwierdzenie komputera (id → nazwa). */
    private val inFlight = HashMap<String, String>()

    fun dir(ctx: Context) = File(ctx.filesDir, "nagrania").apply { mkdirs() }

    val recording get() = rec != null

    @Synchronized
    fun status(): JSONObject = JSONObject().put("recording", rec != null)
        .put("secs", if (rec != null) (System.currentTimeMillis() - started) / 1000 else 0)
        .put("name", file?.name ?: "")

    @Synchronized
    fun start(ctx: Context): JSONObject {
        if (rec != null) return status()
        if (!Info.granted(ctx, android.Manifest.permission.RECORD_AUDIO)) throw IllegalStateException("Brak dostępu do mikrofonu. Zezwól w aplikacji Hermitty na telefonie.")
        if (!LinkService.micReady) throw IllegalStateException("Otwórz raz aplikację Hermitty na telefonie: po restarcie Android wymaga tego, zanim pozwoli włączyć mikrofon zdalnie.")
        val f = File(dir(ctx), "dyktafon-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date()) + ".ogg")
        @Suppress("DEPRECATION")
        val r = if (android.os.Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(48_000)
            r.setAudioEncodingBitRate(24_000)
            r.setOutputFile(f)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            f.delete()
            throw IllegalStateException("Nie udało się włączyć mikrofonu: ${e.message ?: e.javaClass.simpleName}")
        }
        rec = r
        file = f
        started = System.currentTimeMillis()
        LinkService.refresh(ctx)
        Link.event("rec", status())
        return status()
    }

    fun stop(ctx: Context): JSONObject {
        val (f, secs) = synchronized(this) {
            val r = rec ?: return status()
            runCatching { r.stop() }
            r.release()
            rec = null
            val f = file!!
            file = null
            f to (System.currentTimeMillis() - started) / 1000
        }
        LinkService.refresh(ctx)
        val info = entry(f).put("secs", secs)
        Link.event("rec", status().put("last", info))
        if (Store.autoSend) send(ctx, f)
        return info
    }

    private fun entry(f: File) = JSONObject().put("name", f.name).put("size", f.length()).put("date", f.lastModified()).put("sent", f.name in Store.sent)

    fun list(ctx: Context) = JSONArray((dir(ctx).listFiles() ?: emptyArray()).filter { it.name != file?.name }.sortedByDescending { it.lastModified() }.map { entry(it) })

    fun send(ctx: Context, f: File): Boolean {
        val id = "rec-" + f.name
        synchronized(inFlight) { inFlight[id] = f.name }
        return Link.sendFile(id, f, "recording")
    }

    fun confirmed(id: String) {
        val name = synchronized(inFlight) { inFlight.remove(id) } ?: return
        Store.markSent(name)
        Link.event("rec", status())
    }

    /** Po połączeniu: nagrania, które jeszcze nie dotarły na komputer. */
    fun flush(ctx: Context) {
        if (!Store.autoSend) return
        val sent = Store.sent
        for (f in dir(ctx).listFiles() ?: emptyArray()) if (f.name !in sent && f.name != file?.name) if (!send(ctx, f)) return
    }

    fun delete(ctx: Context, name: String) {
        val f = File(dir(ctx), File(name).name)
        if (f.name == file?.name) throw IllegalStateException("To nagranie właśnie trwa.")
        f.delete()
        Store.sent = Store.sent - f.name
    }
}

/** „Znajdź telefon”: alarm na pełnej głośności przez 30 s albo do zatrzymania. */
object Ringer {
    private var tone: Ringtone? = null
    private var oldVolume = -1
    private val main = Handler(Looper.getMainLooper())

    @Synchronized
    fun ring(ctx: Context) {
        stop(ctx)
        val am = ctx.getSystemService(AudioManager::class.java)
        oldVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
        am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        tone = RingtoneManager.getRingtone(ctx, uri)?.apply {
            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
            isLooping = true
            play()
        }
        main.postDelayed({ stop(ctx) }, 30_000)
    }

    @Synchronized
    fun stop(ctx: Context) {
        main.removeCallbacksAndMessages(null)
        tone?.stop()
        tone = null
        if (oldVolume >= 0) ctx.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, oldVolume, 0)
        oldVolume = -1
    }
}
