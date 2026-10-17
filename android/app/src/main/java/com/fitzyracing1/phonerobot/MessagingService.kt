package com.fitzyracing1.phonerobot

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Optional FCM receiver (only active when the app was built with google-services.json). Pushes are wake-up nudges:
 * {kind: "commands", id, type}. The command itself is always fetched from GET /commands, so nothing is lost if a push
 * never arrives.
 */
class MessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val settings = Settings(this)
        if (!settings.configured) return
        Thread {
            try { settings.putStatus("fcm", if (CommandClient(settings).registerFcm(token)) "registered" else "register failed") }
            catch (e: Exception) { settings.putStatus("fcm", "register failed: ${e.javaClass.simpleName}") }
        }.start()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["kind"] != "commands") return
        val settings = Settings(this)
        try {
            if (settings.running) {
                startService(Intent(this, SensorService::class.java).setAction(SensorService.ACTION_POLL))
            } else if (message.data["type"] == "start") {
                // A high-priority FCM message may start a foreground service. Location access from it needs
                // "Allow all the time"; without that Android refuses and the command waits for the next manual start.
                SensorService.start(this)
            }
        } catch (e: Exception) {
            Log.w("phone-robot", "could not act on push: $e")
            settings.putStatus("fcm", "push received but Android refused to start: ${e.javaClass.simpleName}")
        }
    }
}
