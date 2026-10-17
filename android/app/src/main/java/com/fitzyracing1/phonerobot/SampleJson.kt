package com.fitzyracing1.phonerobot

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.round

/** One 10-second sample, in the shape the server's /ingest expects. */
data class Fix(val lat: Double, val lon: Double, val acc: Float?, val alt: Double?, val speed: Float?, val bearing: Float?, val t: Long)
data class Transition(val activity: String, val type: String, val t: Long)

object SampleJson {
    private fun r(v: Double, places: Int): Double {
        var f = 1.0
        repeat(places) { f *= 10 }
        return round(v * f) / f
    }

    private fun stats(s: MotionStats.Snapshot) = JSONObject()
        .put("n", s.n).put("mean", r(s.mean, 3)).put("rms", r(s.rms, 3)).put("peak", r(s.peak, 3))

    fun sample(
        t: Long,
        fix: Fix?,
        activity: String?,
        transitions: List<Transition>,
        accel: MotionStats.Snapshot?,
        gyro: MotionStats.Snapshot?,
        battery: Int?,
        charging: Boolean?,
    ): JSONObject {
        val o = JSONObject().put("t", t)
        if (fix != null) {
            val l = JSONObject().put("lat", r(fix.lat, 7)).put("lon", r(fix.lon, 7)).put("t", fix.t)
            fix.acc?.let { l.put("acc", r(it.toDouble(), 1)) }
            fix.alt?.let { l.put("alt", r(it, 1)) }
            fix.speed?.let { l.put("speed", r(it.toDouble(), 2)) }
            fix.bearing?.let { l.put("bearing", r(it.toDouble(), 1)) }
            o.put("loc", l)
        }
        if (activity != null) o.put("activity", activity)
        if (transitions.isNotEmpty()) {
            val a = JSONArray()
            transitions.forEach { a.put(JSONObject().put("activity", it.activity).put("type", it.type).put("t", it.t)) }
            o.put("transitions", a)
        }
        if (accel != null || gyro != null) {
            val m = JSONObject()
            accel?.let { m.put("accel", stats(it)) }
            gyro?.let { m.put("gyro", stats(it)) }
            o.put("motion", m)
        }
        battery?.let { o.put("battery", it) }
        charging?.let { o.put("charging", it) }
        return o
    }

    /** Wrap queued NDJSON lines into the upload body. Corrupt lines are skipped. */
    fun batch(device: String, lines: List<String>): JSONObject {
        val arr = JSONArray()
        for (line in lines) {
            if (line.isBlank()) continue
            try { arr.put(JSONObject(line)) } catch (_: Exception) { }
        }
        return JSONObject().put("device", device).put("samples", arr)
    }
}
