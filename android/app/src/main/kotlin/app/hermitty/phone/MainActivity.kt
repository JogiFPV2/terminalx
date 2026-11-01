package app.hermitty.phone

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/** Jedyny ekran: stan połączenia, parowanie, uprawnienia, dyktafon i ustawienia. Widoki budowane w kodzie (bez bibliotek). */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: LinearLayout
    private var offLink: (() -> Unit)? = null
    private var found: List<Found> = emptyList()
    private var searching = false
    private var pairing = false
    private var pairMsg: String? = null
    private var hostDraft = ""
    private var codeDraft = ""
    private var portDraft = Link.DEFAULT_PORT
    private val tick = object : Runnable {
        override fun run() { if (Recorder.recording) { render(); main.postDelayed(this, 1000) } }
    }

    private val dark get() = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    private val fg get() = if (dark) Color.rgb(236, 236, 238) else Color.rgb(24, 24, 27)
    private val muted get() = if (dark) Color.rgb(150, 150, 158) else Color.rgb(106, 106, 116)
    private val card get() = if (dark) Color.rgb(30, 30, 34) else Color.rgb(242, 242, 245)
    private val brand = Color.rgb(255, 90, 31)
    private val ok = Color.rgb(34, 170, 90)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Link.init(this)
        actionBar?.hide()
        val scroll = ScrollView(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(root)
        scroll.setOnApplyWindowInsetsListener { v, ins ->
            val b = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(dp(18) + b.left, dp(14) + b.top, dp(18) + b.right, dp(18) + b.bottom)
            ins
        }
        scroll.clipToPadding = false
        setContentView(scroll)
        handleLink(intent)
        offLink = Link.onChange { main.post { render() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        // Otwarta aplikacja może włączyć usługę z mikrofonem: od teraz dyktafon działa też zdalnie i przy blokadzie.
        LinkService.start(this, fromUi = true)
        if (Store.pairing() == null && found.isEmpty()) search()
        render()
        main.post(tick)
    }

    override fun onDestroy() {
        offLink?.invoke()
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** hermitty://pair?c=KOD&h=ip1,ip2&p=port z kodu QR na komputerze. */
    private fun handleLink(i: Intent?) {
        val u = i?.data ?: return
        if (u.scheme != "hermitty" || u.host != "pair") return
        codeDraft = u.getQueryParameter("c") ?: ""
        portDraft = u.getQueryParameter("p")?.toIntOrNull() ?: Link.DEFAULT_PORT
        val hosts = (u.getQueryParameter("h") ?: "").split(',').filter { it.isNotBlank() }
        hostDraft = hosts.firstOrNull() ?: ""
        if (codeDraft.isNotBlank() && hosts.isNotEmpty()) pair(hosts, portDraft, codeDraft)
    }

    /* ---------- akcje ---------- */

    private fun search() {
        if (searching) return
        searching = true
        render()
        Thread {
            val list = runCatching { Link.discover() }.getOrDefault(emptyList())
            main.post { found = list; searching = false; render() }
        }.start()
    }

    private fun pair(hosts: List<String>, port: Int, code: String) {
        if (pairing) return
        pairing = true
        pairMsg = "Paruję…"
        render()
        Thread {
            var err: String? = null
            for (h in hosts) {
                try { Link.pair(this, h, port, code); err = null; break } catch (e: Exception) { err = e.message ?: e.javaClass.simpleName }
            }
            main.post {
                pairing = false
                pairMsg = err
                if (err == null) { codeDraft = ""; LinkService.start(this, fromUi = true); toast("Sparowano z ${Link.pcName}") }
                render()
            }
        }.start()
    }

    private fun ask(vararg perms: String) = requestPermissions(arrayOf(*perms), 1)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        LinkService.start(this, fromUi = true)
        Link.event("info", Info.get(this))
        render()
    }

    private fun openSettings(action: String, uri: Uri? = null) {
        runCatching { startActivity(Intent(action).apply { if (uri != null) data = uri }) }
            .onFailure { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    }

    private fun toggleRec() {
        Thread {
            val r = runCatching { if (Recorder.recording) Recorder.stop(this) else Recorder.start(this) }
            main.post {
                r.exceptionOrNull()?.let { toast(it.message ?: "Błąd") }
                render()
                main.post(tick)
            }
        }.start()
    }

    /* ---------- widok ---------- */

    private fun render() {
        root.removeAllViews()
        val p = Store.pairing()
        root.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(context).apply { text = ">_"; setTextColor(brand); textSize = 26f; typeface = Typeface.MONOSPACE; setPadding(0, 0, dp(10), 0) })
            addView(TextView(context).apply { text = "Hermitty"; setTextColor(fg); textSize = 24f; typeface = Typeface.DEFAULT_BOLD })
        })
        root.addView(text("Telefon jako dodatek do Hermitty na komputerze: SMS-y, powiadomienia i zdalny dyktafon.", muted, 13f).apply { setPadding(0, dp(2), 0, dp(10)) })

        statusCard(p)
        if (p == null) pairCard()
        permsCard()
        if (p != null) recCard()
        settingsCard(p)
        root.addView(text("Wersja ${runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""} · Android ${Build.VERSION.RELEASE}", muted, 11f).apply { gravity = Gravity.CENTER; setPadding(0, dp(14), 0, 0) })
    }

    private fun statusCard(p: Pairing?) = section(null) {
        val (dot, label) = when {
            p == null -> muted to "Nie sparowano z komputerem"
            Link.state == Link.State.ONLINE -> ok to "Połączono z ${Link.pcName}"
            Link.state == Link.State.CONNECTING -> brand to "Łączenie z ${p.pcName}…"
            else -> muted to "${p.pcName}: offline"
        }
        addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(View(context).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(dot) }
                layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(10) }
            })
            addView(text(label, fg, 16f).apply { typeface = Typeface.DEFAULT_BOLD })
        })
        if (p != null && Link.state != Link.State.ONLINE) {
            Link.error?.let { addView(text(it, muted, 12f).apply { setPadding(0, dp(4), 0, 0) }) }
            addView(text("Komputer musi mieć włączony plugin Telefon. Poza domem połącz oba urządzenia przez Tailscale.", muted, 12f).apply { setPadding(0, dp(4), 0, 0) })
            addView(button("Połącz teraz") { Link.kick() })
        }
        if (p != null && !LinkService.micReady && Info.granted(context, Manifest.permission.RECORD_AUDIO)) {
            addView(text("Zdalny dyktafon włączy się, gdy aplikacja będzie otwarta (wymóg Androida po restarcie).", muted, 12f).apply { setPadding(0, dp(4), 0, 0) })
        }
    }

    private fun pairCard() = section("Parowanie") {
        addView(text("1. W Hermitty na komputerze włącz plugin Telefon (Ustawienia → Pluginy) i kliknij „Sparuj telefon”.\n2. Zeskanuj kod QR aparatem albo wybierz komputer i przepisz kod.", fg, 14f))
        addView(text(if (searching) "Szukam komputerów w tej sieci…" else if (found.isEmpty()) "Nie znaleziono komputera w tej sieci Wi-Fi. Wpisz adres ręcznie (np. adres Tailscale 100.x.x.x)." else "Komputery w tej sieci:", muted, 12f).apply { setPadding(0, dp(10), 0, dp(4)) })
        for (f in found) addView(button((if (hostDraft == f.host) "● " else "") + "${f.name}  ·  ${f.host}", primary = hostDraft == f.host) { hostDraft = f.host; portDraft = f.port; render() })
        if (!searching) addView(button("Szukaj ponownie") { search() })
        val host = input("Adres komputera", hostDraft) { hostDraft = it }
        val code = input("Kod z ekranu komputera, np. ABCD-EFGH-JKMN", codeDraft, caps = true) { codeDraft = it }
        addView(host)
        addView(code)
        pairMsg?.let { addView(text(it, if (pairing) muted else Color.rgb(220, 60, 60), 13f).apply { setPadding(0, dp(6), 0, 0) }) }
        addView(button(if (pairing) "Paruję…" else "Sparuj", primary = true) {
            val h = hostDraft.trim()
            if (h.isEmpty() || codeDraft.isBlank()) { toast("Podaj adres komputera i kod."); return@button }
            val parts = h.split(':')
            pair(listOf(parts[0]), parts.getOrNull(1)?.toIntOrNull() ?: portDraft, codeDraft)
        })
    }

    private fun permsCard() = section("Uprawnienia") {
        fun row(title: String, desc: String, granted: Boolean, fix: () -> Unit) = addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                addView(text((if (granted) "✓  " else "○  ") + title, if (granted) fg else fg, 15f))
                addView(text(desc, muted, 12f))
            })
            if (!granted) addView(button("Zezwól", primary = true, wrap = true) { fix() })
        })
        if (Build.VERSION.SDK_INT >= 33) {
            row("Powiadomienie usługi", "Widoczne, gdy telefon jest połączony z komputerem.", Info.granted(context, Manifest.permission.POST_NOTIFICATIONS)) { ask(Manifest.permission.POST_NOTIFICATIONS) }
        }
        row("Dostęp do powiadomień", "Powiadomienia innych aplikacji na komputerze, odpowiadanie z komputera.", Info.notifAccess(context)) {
            val detail = Build.VERSION.SDK_INT >= 30 && runCatching {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(context, NotifService::class.java).flattenToString()))
            }.isSuccess
            if (!detail) openSettings(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        }
        row("SMS-y i kontakty", "Czytanie i wysyłanie SMS-ów z komputera, nazwy zamiast numerów.", Info.granted(context, Manifest.permission.READ_SMS) && Info.granted(context, Manifest.permission.SEND_SMS)) {
            ask(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS)
        }
        row("Mikrofon", "Dyktafon włączany z komputera, także przy zablokowanym ekranie.", Info.granted(context, Manifest.permission.RECORD_AUDIO)) { ask(Manifest.permission.RECORD_AUDIO) }
        row("Bateria bez ograniczeń", "Bez tego system usypia połączenie po kilku minutach.", Info.batteryFree(context)) {
            openSettings(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        }
        addView(text("Przełącznik jest wyszarzony? Android blokuje część uprawnień aplikacjom spoza Sklepu Play. Otwórz Informacje o aplikacji → ⋮ (w prawym górnym rogu) → „Zezwól na ustawienia z ograniczeniami” i wróć tutaj.", muted, 12f).apply { setPadding(0, dp(6), 0, 0) })
        addView(button("Informacje o aplikacji") { openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")) })
    }

    private fun recCard() = section("Dyktafon") {
        val st = Recorder.status()
        val secs = st.optLong("secs")
        addView(button(if (Recorder.recording) "■  Zatrzymaj  ·  ${secs / 60}:${"%02d".format(secs % 60)}" else "●  Nagrywaj", primary = true) { toggleRec() })
        addView(text("Nagranie można też włączyć z komputera. " + if (Store.autoSend) "Po zatrzymaniu trafia na komputer." else "Wysyłanie ręczne (ustawienie niżej).", muted, 12f).apply { setPadding(0, dp(4), 0, dp(4)) })
        val list = Recorder.list(context)
        for (i in 0 until minOf(list.length(), 8)) {
            val r: JSONObject = list.getJSONObject(i)
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, dp(4))
                addView(text(r.getString("name").removePrefix("dyktafon-").removeSuffix(".ogg") + "  ·  ${r.getLong("size") / 1024} KB" + if (r.optBoolean("sent")) "  ✓" else "", fg, 13f).apply { layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
                if (!r.optBoolean("sent") && Link.state == Link.State.ONLINE) addView(button("Wyślij", wrap = true) {
                    Thread { Recorder.send(context, java.io.File(Recorder.dir(context), r.getString("name"))) }.start()
                })
                addView(button("Usuń", wrap = true) { runCatching { Recorder.delete(context, r.getString("name")) }; render() })
            })
        }
    }

    private fun settingsCard(p: Pairing?) = section("Ustawienia") {
        fun sw(label: String, desc: String, value: Boolean, set: (Boolean) -> Unit) = addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(4), 0, dp(4))
            addView(Switch(context).apply { text = label; textSize = 15f; setTextColor(fg); isChecked = value; setOnCheckedChangeListener { _, v -> set(v) } })
            addView(text(desc, muted, 12f))
        })
        sw("Pokazuj kody jednorazowe", "Domyślnie kody z SMS-ów i powiadomień (logowanie, BLIK) są na komputerze zamaskowane.", Store.showCodes) { Store.showCodes = it }
        sw("Wysyłaj nagrania automatycznie", "Gotowe nagranie od razu trafia na komputer.", Store.autoSend) { Store.autoSend = it }
        if (p != null) addView(button("Zapomnij komputer ${p.pcName}") {
            Link.unpair()
            LinkService.stop(context)
            found = emptyList()
            search()
            render()
        })
    }

    /* ---------- klocki ---------- */

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, color: Int, size: Float) = TextView(this).apply { text = s; setTextColor(color); textSize = size }

    private fun section(title: String?, body: LinearLayout.() -> Unit) {
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(card) }
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
            if (title != null) addView(text(title, fg, 17f).apply { typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, dp(6)) })
            body()
        })
    }

    private fun button(label: String, primary: Boolean = false, wrap: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        if (primary) { backgroundTintList = ColorStateList.valueOf(brand); setTextColor(Color.WHITE) }
        layoutParams = LinearLayout.LayoutParams(if (wrap) -2 else -1, -2).apply { topMargin = dp(4) }
        setOnClickListener { onClick() }
    }

    private fun input(hint: String, value: String, caps: Boolean = false, onChange: (String) -> Unit) = EditText(this).apply {
        this.hint = hint
        setText(value)
        setTextColor(fg)
        setHintTextColor(muted)
        isSingleLine = true
        inputType = if (caps) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) = onChange(s?.toString() ?: "")
        })
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
