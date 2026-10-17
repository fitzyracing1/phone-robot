package com.fitzyracing1.phonerobot

import java.net.HttpURLConnection
import java.net.URL

/** Tiny HTTPS helper shared by the uploader, command client and FCM registration. Throws IOException on network errors. */
object Http {
    data class Response(val code: Int, val body: String)

    fun request(method: String, url: String, token: String, body: ByteArray? = null): Response {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 20_000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("authorization", "Bearer $token")
            conn.setRequestProperty("user-agent", "phone-robot/${BuildConfig.VERSION_NAME} (+https://github.com/fitzyracing1/phone-robot)")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("content-type", "application/json")
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val text = (if (code >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Response(code, text)
        } finally {
            conn.disconnect()
        }
    }
}
