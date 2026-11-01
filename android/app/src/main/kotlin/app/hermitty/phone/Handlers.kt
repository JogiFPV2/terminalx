package app.hermitty.phone

import android.content.Context
import org.json.JSONObject
import java.io.File

/** Żądania z komputera. Wynik trafia do odpowiedzi „res”, wyjątek staje się komunikatem błędu. */
object Handlers {
    fun handle(ctx: Context, m: String, p: JSONObject): Any? = when (m) {
        "info" -> Info.get(ctx)
        "notif.list" -> NotifService.list()
        "notif.reply" -> NotifService.action(p.getString("key"), p.getInt("action"), p.getString("text")).let { true }
        "notif.action" -> NotifService.action(p.getString("key"), p.getInt("action"), null).let { true }
        "notif.dismiss" -> NotifService.dismiss(p.getString("key")).let { true }
        "sms.threads" -> Sms.threads(ctx, p.optInt("limit", 40).coerceIn(1, 200))
        "sms.thread" -> Sms.thread(ctx, p.getLong("thread"), p.optInt("limit", 60).coerceIn(1, 500))
        "sms.send" -> Sms.send(ctx, p.getString("to"), p.getString("body")).let { true }
        "rec.start" -> Recorder.start(ctx)
        "rec.stop" -> Recorder.stop(ctx)
        "rec.status" -> Recorder.status()
        "rec.list" -> Recorder.list(ctx)
        "rec.send" -> {
            val f = File(Recorder.dir(ctx), File(p.getString("name")).name)
            if (!f.exists()) throw IllegalStateException("Nie ma takiego nagrania.")
            Recorder.send(ctx, f)
        }
        "rec.delete" -> Recorder.delete(ctx, p.getString("name")).let { true }
        "ring" -> Ringer.ring(ctx).let { true }
        "ring.stop" -> Ringer.stop(ctx).let { true }
        else -> throw IllegalArgumentException("Nieznana metoda $m. Zaktualizuj aplikację na telefonie.")
    }
}
