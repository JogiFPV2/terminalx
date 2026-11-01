package app.hermitty.phone

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/** Powiadomienia innych aplikacji: przekazywanie na komputer, odpowiadanie i zamykanie. */
class NotifService : NotificationListenerService() {
    companion object {
        @Volatile var inst: NotifService? = null

        private fun need(): NotifService = inst ?: throw IllegalStateException("Brak dostępu do powiadomień. Włącz go w aplikacji Hermitty na telefonie.")

        fun list(): JSONArray {
            val s = need()
            return JSONArray((s.activeNotifications ?: emptyArray()).sortedByDescending { it.postTime }.mapNotNull { s.json(it) })
        }

        fun action(key: String, index: Int, text: String?) {
            val s = need()
            val sbn = s.activeNotifications?.firstOrNull { it.key == key } ?: throw IllegalStateException("Tego powiadomienia już nie ma.")
            val a = sbn.notification.actions?.getOrNull(index) ?: throw IllegalStateException("Nie ma takiej akcji.")
            val inputs = a.remoteInputs
            if (text != null && !inputs.isNullOrEmpty()) {
                val intent = Intent()
                val results = Bundle()
                inputs.forEach { results.putCharSequence(it.resultKey, text) }
                RemoteInput.addResultsToIntent(inputs, intent, results)
                a.actionIntent.send(s, 0, intent)
            } else {
                a.actionIntent.send()
            }
        }

        fun dismiss(key: String) = need().cancelNotification(key)
    }

    private val labels = HashMap<String, String>()

    override fun onListenerConnected() { inst = this }
    override fun onListenerDisconnected() { if (inst === this) inst = null }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        json(sbn)?.let { Link.event("notif", it) }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        if (sbn.packageName != packageName) Link.event("notif.removed", JSONObject().put("key", sbn.key))
    }

    @Suppress("DEPRECATION")
    private fun label(pkg: String) = labels.getOrPut(pkg) {
        runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrNull() ?: pkg
    }

    /** Bez własnych, trwałych (muzyka, nawigacja) i zbiorczych; rozmowy przychodzące zostają. */
    fun json(sbn: StatusBarNotification): JSONObject? {
        Store.init(this)
        if (sbn.packageName == packageName) return null
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null
        if (sbn.isOngoing && n.category != Notification.CATEGORY_CALL) return null
        val ex = n.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        if (title.isBlank() && text.isBlank()) return null
        val actions = JSONArray()
        n.actions?.forEachIndexed { i, a ->
            actions.put(JSONObject().put("i", i).put("title", a.title?.toString() ?: "").put("reply", a.remoteInputs?.any { it.allowFreeFormInput } == true))
        }
        return JSONObject()
            .put("key", sbn.key).put("pkg", sbn.packageName).put("app", label(sbn.packageName))
            .put("title", Mask.apply(title)).put("text", Mask.apply(text)).put("time", sbn.postTime)
            .put("call", n.category == Notification.CATEGORY_CALL).put("clearable", sbn.isClearable)
            .put("actions", actions)
    }
}
