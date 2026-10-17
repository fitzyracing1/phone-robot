package com.fitzyracing1.phonerobot

import android.os.Handler
import java.io.IOException
import java.text.DateFormat
import java.util.Date

/**
 * Sends sealed batches to POST {server}/ingest with the bearer token, oldest first, on the service's worker thread.
 * Retries with exponential backoff (30 s → 15 min). No wake locks: a retry that comes due while the CPU sleeps simply
 * runs at the next wake-up (the location callback every ~10 s, or the network coming back).
 */
class Uploader(private val queue: SampleQueue, private val settings: Settings, private val worker: Handler) {
    private var backoffMs = 0L
    private var scheduled = false
    private val runnable = Runnable { scheduled = false; drain() }

    /** Ask for an upload soon. Ignored while a backoff is pending, unless [force] (e.g. network came back). */
    fun kick(force: Boolean = false) {
        if (scheduled && !force) return
        worker.removeCallbacks(runnable)
        if (force) backoffMs = 0
        scheduled = true
        worker.post(runnable)
    }

    fun stop() { worker.removeCallbacks(runnable); scheduled = false }

    private fun retryLater(reason: String, minMs: Long = 30_000) {
        backoffMs = (if (backoffMs == 0L) minMs else backoffMs * 2).coerceIn(minMs, 15 * 60_000L)
        settings.putStatus("upload", "waiting ${backoffMs / 1000}s: $reason")
        scheduled = true
        worker.postDelayed(runnable, backoffMs)
    }

    private fun drain() {
        if (!settings.configured) { settings.putStatus("upload", "not configured (set server URL and token)"); return }
        for (f in queue.batches().take(20)) {
            val lines = queue.read(f)
            if (lines.isEmpty()) { queue.done(f); continue }
            val body = SampleJson.batch(settings.device, lines).toString().toByteArray(Charsets.UTF_8)
            val code = try { post(body) } catch (e: IOException) { return retryLater(e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "")) }
            when {
                code in 200..299 -> {
                    queue.done(f)
                    backoffMs = 0
                    settings.putStatus("lastUpload", DateFormat.getTimeInstance().format(Date()) + " (${lines.size} samples)")
                    settings.putStatus("upload", "ok")
                }
                code == 401 || code == 403 -> return retryLater("server rejected the token (HTTP $code)", 5 * 60_000L)
                code == 400 || code == 413 || code == 422 -> { queue.reject(f); settings.putStatus("upload", "server rejected a batch (HTTP $code); set aside") }
                else -> return retryLater("HTTP $code")
            }
        }
        if (queue.size() > 0) kick()
    }

    private fun post(body: ByteArray): Int = Http.request("POST", settings.ingestUrl, settings.token, body).code
}

