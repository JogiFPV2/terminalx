package app.hermitty.phone

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** SMS-y: lista rozmów, jedna rozmowa, wysyłanie. Wysłane SMS-y system sam zapisuje w skrzynce. */
object Sms {
    private val names = HashMap<String, String>()

    private fun need(ctx: Context, vararg p: String) {
        if (p.any { !Info.granted(ctx, it) }) throw IllegalStateException("Brak dostępu do SMS-ów. Zezwól w aplikacji Hermitty na telefonie.")
    }

    fun name(ctx: Context, addr: String): String {
        if (addr.isBlank() || !Info.granted(ctx, Manifest.permission.READ_CONTACTS)) return ""
        return names.getOrPut(addr) {
            runCatching {
                val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(addr))
                ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                }
            }.getOrNull() ?: ""
        }
    }

    private fun row(ctx: Context, c: android.database.Cursor) = JSONObject()
        .put("id", c.getLong(0)).put("thread", c.getLong(1))
        .put("addr", c.getString(2) ?: "").put("name", name(ctx, c.getString(2) ?: ""))
        .put("body", Mask.apply(c.getString(3))).put("date", c.getLong(4))
        .put("out", c.getInt(5) != Telephony.Sms.MESSAGE_TYPE_INBOX).put("read", c.getInt(6) == 1)

    private val PROJ = arrayOf(Telephony.Sms._ID, Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ)

    fun threads(ctx: Context, limit: Int): JSONArray {
        need(ctx, Manifest.permission.READ_SMS)
        val seen = LinkedHashMap<Long, JSONObject>()
        val unread = HashMap<Long, Int>()
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, PROJ, null, null, "${Telephony.Sms.DATE} DESC LIMIT 3000")?.use { c ->
            while (c.moveToNext()) {
                val t = c.getLong(1)
                if (c.getInt(6) == 0 && c.getInt(5) == Telephony.Sms.MESSAGE_TYPE_INBOX) unread[t] = (unread[t] ?: 0) + 1
                if (t !in seen && seen.size < limit) seen[t] = row(ctx, c)
            }
        }
        return JSONArray(seen.map { (t, j) -> j.put("unread", unread[t] ?: 0) })
    }

    fun thread(ctx: Context, thread: Long, limit: Int): JSONArray {
        need(ctx, Manifest.permission.READ_SMS)
        val list = mutableListOf<JSONObject>()
        ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, PROJ, "${Telephony.Sms.THREAD_ID}=?", arrayOf(thread.toString()), "${Telephony.Sms.DATE} DESC LIMIT $limit")?.use { c ->
            while (c.moveToNext()) list += row(ctx, c)
        }
        return JSONArray(list.reversed())
    }

    fun send(ctx: Context, to: String, body: String) {
        need(ctx, Manifest.permission.SEND_SMS)
        if (to.isBlank() || body.isBlank()) throw IllegalArgumentException("Podaj numer i treść.")
        val sm = ctx.getSystemService(SmsManager::class.java)
        val parts = sm.divideMessage(body)
        if (parts.size > 1) sm.sendMultipartTextMessage(to, null, parts, null, null) else sm.sendTextMessage(to, null, body, null, null)
    }
}

/** Nowy SMS: od razu na komputer (jeśli połączony). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        Store.init(ctx)
        val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        for ((addr, parts) in msgs.groupBy { it.originatingAddress ?: "" }) {
            val body = parts.joinToString("") { it.messageBody ?: "" }
            Link.event("sms", JSONObject().put("addr", addr).put("name", Sms.name(ctx, addr)).put("body", Mask.apply(body)).put("date", parts.first().timestampMillis))
        }
    }
}
