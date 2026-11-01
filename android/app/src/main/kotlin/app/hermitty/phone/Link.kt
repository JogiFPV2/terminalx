package app.hermitty.phone

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors

/** Komputer znaleziony w sieci lokalnej. */
data class Found(val id: String, val name: String, val host: String, val port: Int)

/**
 * Połączenie z Hermitty na komputerze: jeden wątek łączy się, czyta ramki i wznawia połączenie po zerwaniu.
 * Żądania komputera obsługuje mała pula wątków, a zapis ramek jest synchronizowany (wspólny licznik nonce).
 */
object Link {
    const val DEFAULT_PORT = 47390

    enum class State { UNPAIRED, CONNECTING, ONLINE, OFFLINE }

    @Volatile var state = State.OFFLINE; private set
    @Volatile var error: String? = null; private set
    @Volatile var pcName: String = ""; private set

    private lateinit var ctx: Context
    private var thread: Thread? = null
    private val wake = Object()
    private val pool = Executors.newFixedThreadPool(2)
    private val listeners = mutableSetOf<() -> Unit>()

    private val writeLock = Object()
    @Volatile private var socket: Socket? = null
    private var out: DataOutputStream? = null
    private var tx: Crypto.Dir? = null

    fun onChange(cb: () -> Unit): () -> Unit {
        synchronized(listeners) { listeners += cb }
        return { synchronized(listeners) { listeners -= cb } }
    }

    private fun changed() = synchronized(listeners) { listeners.toList() }.forEach { runCatching { it() } }

    private fun set(s: State, err: String? = error) {
        if (s == state && err == error) return
        state = s
        error = err
        changed()
    }

    fun init(c: Context) {
        if (!::ctx.isInitialized) ctx = c.applicationContext
        Store.init(ctx)
    }

    fun start(c: Context) {
        init(c)
        if (thread?.isAlive == true) { kick(); return }
        thread = Thread(::loop, "hermitty-link").apply { isDaemon = true; start() }
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = kick()
            override fun onLost(network: Network) { runCatching { socket?.close() } }
        })
    }

    /** Budzi pętlę (zmiana sieci, nowe parowanie, ręczne „Połącz”). */
    fun kick() = synchronized(wake) { wake.notifyAll() }

    private fun sleep(ms: Long) = synchronized(wake) { wake.wait(ms) }

    private fun loop() {
        var backoff = 2_000L
        while (true) {
            val p = Store.pairing()
            if (p == null) {
                set(State.UNPAIRED, null)
                sleep(60_000)
                continue
            }
            pcName = p.pcName
            set(State.CONNECTING)
            var hosts = p.hosts
            var connected = false
            for (round in 0..1) {
                for (h in hosts) {
                    try {
                        session(h, p.port, p)
                        connected = true
                        break
                    } catch (e: Exception) {
                        error = e.message ?: e.javaClass.simpleName
                    }
                }
                if (connected) break
                // Komputer mógł dostać nowy adres w sieci: szukamy go po id.
                val found = discover(p.port).filter { it.id == p.pcId }.map { it.host }
                hosts = found.filter { it !in hosts }
                if (hosts.isEmpty()) break
            }
            if (connected) backoff = 2_000L
            if (Store.pairing() == null) continue
            set(State.OFFLINE)
            sleep(backoff)
            backoff = (backoff * 2).coerceAtMost(60_000)
        }
    }

    private fun connect(host: String, port: Int): Socket = Socket().apply {
        connect(InetSocketAddress(host, port), 4_000)
        tcpNoDelay = true
        keepAlive = true
        // Komputer pinguje co 30 s; po 150 s ciszy połączenie uznajemy za martwe.
        soTimeout = 150_000
    }

    private fun session(host: String, port: Int, p: Pairing) {
        val s = connect(host, port)
        s.use {
            val inp = DataInputStream(BufferedInputStream(s.getInputStream()))
            val o = DataOutputStream(BufferedOutputStream(s.getOutputStream()))
            val hi = JSONObject(String(Crypto.readFrame(inp)))
            if (hi.optString("t") != "hi") throw IOException("To nie jest Hermitty")
            if (p.pcId.isNotEmpty() && hi.optString("pc") != p.pcId) throw IOException("Pod $host działa inny komputer")
            val cs = Crypto.unb64(hi.getString("c"))
            val cc = Crypto.random(16)
            Crypto.writeFrame(o, JSONObject().put("t", "hello").put("device", p.deviceId).put("c", Crypto.b64(cc)).toString().toByteArray())
            val sealer = Crypto.Dir(Crypto.sessionKey(p.key, "c2s", cs, cc))
            val rx = Crypto.Dir(Crypto.sessionKey(p.key, "s2c", cs, cc))
            Crypto.writeFrame(o, sealer.seal(JSONObject().put("t", "auth").put("name", deviceName()).put("model", model()).put("info", Info.get(ctx)).toString().toByteArray()))
            val first = Crypto.readFrame(inp)
            val ready = rx.open(first)?.let { JSONObject(String(it)) }
            if (ready == null) {
                val err = runCatching { JSONObject(String(first)) }.getOrNull()
                throw IOException(err?.optString("msg")?.ifBlank { null } ?: "Komputer odrzucił połączenie")
            }
            ready.optString("name").takeIf { it.isNotBlank() }?.let { pcName = it; Store.setPcName(it) }
            Store.rememberHost(host, port)

            synchronized(writeLock) { socket = s; out = o; tx = sealer }
            set(State.ONLINE, null)
            pool.execute { Recorder.flush(ctx) }
            try {
                while (true) {
                    val msg = rx.open(Crypto.readFrame(inp))?.let { JSONObject(String(it)) } ?: throw IOException("Zła ramka")
                    when (msg.optString("t")) {
                        "req" -> pool.execute { answer(msg) }
                        "ping" -> send(JSONObject().put("t", "pong"))
                        "fileok" -> Recorder.confirmed(msg.optString("id"))
                        "unpaired" -> { Store.forget(); return }
                    }
                }
            } finally {
                synchronized(writeLock) { socket = null; out = null; tx = null }
            }
        }
    }

    private fun answer(req: JSONObject) {
        val res = JSONObject().put("t", "res").put("id", req.optLong("id"))
        try {
            res.put("ok", true).put("v", Handlers.handle(ctx, req.optString("m"), req.optJSONObject("p") ?: JSONObject()) ?: JSONObject.NULL)
        } catch (e: Exception) {
            res.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
        }
        send(res)
    }

    /** Wysyła wiadomość, jeśli jest połączenie. Zwraca false offline. */
    fun send(msg: JSONObject): Boolean = synchronized(writeLock) {
        val o = out ?: return false
        val t = tx ?: return false
        try {
            Crypto.writeFrame(o, t.seal(msg.toString().toByteArray()))
            true
        } catch (e: IOException) {
            runCatching { socket?.close() }
            false
        }
    }

    fun event(name: String, payload: Any) = send(JSONObject().put("t", "ev").put("e", name).put("p", payload))

    /** Plik w kawałkach po 48 KB; komputer potwierdza całość ramką „fileok”. */
    fun sendFile(id: String, file: File, kind: String, extra: JSONObject = JSONObject()): Boolean {
        val buf = ByteArray(48 * 1024)
        file.inputStream().use { inp ->
            var seq = 0
            var left = file.length()
            do {
                val n = inp.read(buf).coerceAtLeast(0)
                left -= n
                val m = JSONObject().put("t", "file").put("id", id).put("kind", kind).put("name", file.name)
                    .put("seq", seq++).put("data", Crypto.b64(buf.copyOf(n))).put("last", left <= 0)
                extra.keys().forEach { m.put(it, extra.get(it)) }
                if (!send(m)) return false
            } while (left > 0)
        }
        return true
    }

    /* ---------- parowanie ---------- */

    /** Parowanie kodem z ekranu komputera. Działa w wątku wywołującym (wywołuj poza wątkiem UI). */
    fun pair(c: Context, host: String, port: Int, code: String) {
        init(c)
        val base = Crypto.pairKey(code)
        connect(host, port).use { s ->
            val inp = DataInputStream(BufferedInputStream(s.getInputStream()))
            val o = DataOutputStream(BufferedOutputStream(s.getOutputStream()))
            val hi = JSONObject(String(Crypto.readFrame(inp)))
            if (hi.optString("t") != "hi") throw IOException("Pod tym adresem nie ma Hermitty")
            val cs = Crypto.unb64(hi.getString("c"))
            val cc = Crypto.random(16)
            Crypto.writeFrame(o, JSONObject().put("t", "pair").put("c", Crypto.b64(cc)).toString().toByteArray())
            val sealer = Crypto.Dir(Crypto.sessionKey(base, "c2s", cs, cc))
            val rx = Crypto.Dir(Crypto.sessionKey(base, "s2c", cs, cc))
            Crypto.writeFrame(o, sealer.seal(JSONObject().put("t", "auth").put("name", deviceName()).put("model", model()).put("info", Info.get(ctx)).toString().toByteArray()))
            val first = Crypto.readFrame(inp)
            val paired = rx.open(first)?.let { JSONObject(String(it)) }
                ?: throw IOException(runCatching { JSONObject(String(first)).optString("msg") }.getOrNull()?.ifBlank { null } ?: "Zły kod parowania")
            if (paired.optString("t") != "paired") throw IOException("Nieoczekiwana odpowiedź komputera")
            Store.savePairing(
                Pairing(
                    paired.getString("device"), paired.optString("pc", hi.optString("pc")), paired.optString("name", hi.optString("name")),
                    listOf(host), port, Crypto.unb64(paired.getString("key")),
                ),
            )
        }
        pcName = Store.pairing()?.pcName ?: ""
        kick()
    }

    fun unpair() {
        Store.forget()
        runCatching { socket?.close() }
        kick()
    }

    /* ---------- wyszukiwanie w sieci lokalnej ---------- */

    fun discover(port: Int = DEFAULT_PORT, ms: Long = 1_500): List<Found> {
        val out = linkedMapOf<String, Found>()
        runCatching {
            DatagramSocket().use { s ->
                s.broadcast = true
                s.soTimeout = 300
                val msg = "HERMITTY?".toByteArray()
                for (b in broadcasts()) runCatching { s.send(DatagramPacket(msg, msg.size, b, port)) }
                val buf = ByteArray(1024)
                val end = System.currentTimeMillis() + ms
                while (System.currentTimeMillis() < end) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try { s.receive(pkt) } catch (e: java.net.SocketTimeoutException) { continue }
                    val j = runCatching { JSONObject(String(pkt.data, 0, pkt.length)) }.getOrNull() ?: continue
                    if (j.optString("t") != "hermitty") continue
                    val host = pkt.address.hostAddress ?: continue
                    out[j.optString("id") + host] = Found(j.optString("id"), j.optString("name", "Komputer"), host, j.optInt("port", port))
                }
            }
        }
        return out.values.toList()
    }

    /** Adresy rozgłoszeniowe aktywnych sieci (np. 192.168.1.255) i ogólny 255.255.255.255. */
    private fun broadcasts(): List<InetAddress> {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val list = mutableListOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        for (n in cm.allNetworks) {
            val lp = cm.getLinkProperties(n) ?: continue
            for (la in lp.linkAddresses) {
                val a = la.address as? Inet4Address ?: continue
                val bits = la.prefixLength
                if (bits !in 8..30) continue
                val ip = a.address.fold(0) { acc, b -> (acc shl 8) or (b.toInt() and 0xff) }
                val bc = ip or ((1 shl (32 - bits)) - 1)
                list += InetAddress.getByAddress(byteArrayOf((bc ushr 24).toByte(), (bc ushr 16).toByte(), (bc ushr 8).toByte(), bc.toByte()))
            }
        }
        return list.distinct()
    }

    fun deviceName(): String = runCatching {
        android.provider.Settings.Global.getString(ctx.contentResolver, "device_name")
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: model()

    fun model(): String = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".trim()
}
