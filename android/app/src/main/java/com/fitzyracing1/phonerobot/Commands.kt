package com.fitzyracing1.phonerobot

import org.json.JSONArray
import org.json.JSONObject

/** A command from the server: start / stop / ping / notify. Anything else is ignored. */
data class Command(val id: String, val type: String, val args: Map<String, String>)
data class Ack(val id: String, val ok: Boolean, val result: JSONObject? = null)

object CommandCodec {
    val TYPES = setOf("start", "stop", "ping", "notify")
    private val ID = Regex("^[A-Za-z0-9-]{1,64}$")

    /** Parse GET /commands. Unknown types, bad ids and non-string args are dropped; notify text is clamped. */
    fun parse(json: String): List<Command> {
        val arr = try { JSONObject(json).optJSONArray("commands") } catch (_: Exception) { null } ?: return emptyList()
        val out = mutableListOf<Command>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id")
            val type = o.optString("type")
            if (!ID.matches(id) || type !in TYPES) continue
            val args = mutableMapOf<String, String>()
            o.optJSONObject("args")?.let { a ->
                for (k in a.keys()) {
                    val v = a.opt(k)
                    if (v is String) args[k] = v.take(if (k == "body") 240 else 120)
                }
            }
            if (type == "notify" && args["body"].isNullOrBlank()) continue
            out.add(Command(id, type, args))
        }
        return out
    }

    fun ackBody(device: String, acks: List<Ack>): JSONObject {
        val arr = JSONArray()
        acks.forEach { a -> arr.put(JSONObject().put("id", a.id).put("ok", a.ok).apply { a.result?.let { put("result", it) } }) }
        return JSONObject().put("device", device).put("acks", arr)
    }

    fun pollSeconds(json: String): Int = try { JSONObject(json).optInt("pollSeconds", 60).coerceIn(15, 900) } catch (_: Exception) { 60 }
}

/** Remembers recently handled command ids so a redelivered command (ack lost) isn't run twice. */
class SeenIds(private val max: Int = 200) {
    private val ids = LinkedHashSet<String>()

    @Synchronized fun firstTime(id: String): Boolean {
        if (ids.contains(id)) return false
        ids.add(id)
        while (ids.size > max) ids.remove(ids.first())
        return true
    }

    @Synchronized fun snapshot(): List<String> = ids.toList()
    @Synchronized fun restore(list: List<String>) { list.takeLast(max).forEach { ids.add(it) } }
}

/** Talks to GET /commands and POST /commands/ack. Returns null when the server predates milestone 2 (404). */
class CommandClient(private val settings: Settings) {
    data class Poll(val commands: List<Command>, val pollSeconds: Int)

    fun poll(): Poll? {
        val r = Http.request("GET", "${settings.serverUrl}/commands?device=${settings.device}", settings.token)
        if (r.code == 404) return null
        if (r.code !in 200..299) throw java.io.IOException("GET /commands HTTP ${r.code}")
        return Poll(CommandCodec.parse(r.body), CommandCodec.pollSeconds(r.body))
    }

    fun ack(acks: List<Ack>): Boolean {
        if (acks.isEmpty()) return true
        val r = Http.request("POST", "${settings.serverUrl}/commands/ack", settings.token, CommandCodec.ackBody(settings.device, acks).toString().toByteArray())
        return r.code in 200..299
    }

    fun registerFcm(token: String): Boolean {
        val body = JSONObject().put("device", settings.device).put("token", token).toString().toByteArray()
        return Http.request("POST", "${settings.serverUrl}/devices/fcm", settings.token, body).code in 200..299
    }
}
