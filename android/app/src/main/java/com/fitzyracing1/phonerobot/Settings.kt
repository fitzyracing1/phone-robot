package com.fitzyracing1.phonerobot

import android.content.Context
import android.os.Build
import java.net.URI

/** User settings plus a little status the service writes and the screen reads. App-private, never backed up. */
class Settings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("phone_robot", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(v) = prefs.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    var device: String
        get() = prefs.getString("device", null) ?: defaultDevice()
        set(v) = prefs.edit().putString("device", cleanDevice(v)).apply()

    var running: Boolean
        get() = prefs.getBoolean("running", false)
        set(v) = prefs.edit().putBoolean("running", v).apply()

    fun putStatus(key: String, value: String) = prefs.edit().putString("status.$key", value).apply()
    fun status(key: String): String = prefs.getString("status.$key", "") ?: ""

    val ingestUrl: String get() = "$serverUrl/ingest"
    val configured: Boolean get() = validUrl(serverUrl) == null && token.isNotEmpty()

    companion object {
        private val DEVICE_BAD = Regex("[^A-Za-z0-9._-]")

        fun cleanDevice(v: String): String = v.trim().replace(' ', '-').replace(DEVICE_BAD, "").take(64).ifEmpty { "phone" }

        fun defaultDevice(): String = cleanDevice(Build.MODEL ?: "phone").lowercase()

        /** Returns null when the URL is usable, else a reason. HTTPS only (the upload carries location and a token). */
        fun validUrl(url: String): String? {
            if (url.isBlank()) return "Server URL is empty"
            val u = try { URI(url.trim()) } catch (e: Exception) { return "Server URL is not a valid URL" }
            if (u.scheme?.lowercase() != "https") return "Server URL must start with https://"
            if (u.host.isNullOrBlank()) return "Server URL has no host"
            return null
        }
    }
}
