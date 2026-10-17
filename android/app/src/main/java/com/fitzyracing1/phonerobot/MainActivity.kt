package com.fitzyracing1.phonerobot

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

/**
 * Settings + start/stop. Permissions are asked one step at a time, each when it's needed:
 *  1. location (fine; coarse works but the track will be rough)  → required to start
 *  2. notifications (Android 13+)                                 → optional; logging works without the shade entry
 *  3. physical activity (Android 10+)                             → optional; without it there are no transitions
 *  4. "all the time" location (Android 10+, separate button)      → optional; only for restarts while the app is closed
 */
class MainActivity : ComponentActivity() {
    private lateinit var settings: Settings
    private lateinit var status: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val refresher = object : Runnable {
        override fun run() { render(); ui.postDelayed(this, 2_000) }
    }

    private val locationPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val fine = res[Manifest.permission.ACCESS_FINE_LOCATION] == true || granted(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = res[Manifest.permission.ACCESS_COARSE_LOCATION] == true || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        when {
            fine -> askNotifications()
            coarse -> {
                Toast.makeText(this, "Approximate location only: the track will be rough. Choose \"Precise\" in app settings for a real track.", Toast.LENGTH_LONG).show()
                askNotifications()
            }
            else -> deniedDialog("Location", "phone-robot can't log without location access.", Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }
    private val notificationPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { askActivity() }
    private val activityPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) Toast.makeText(this, "Without physical activity access, walking/driving transitions won't be logged.", Toast.LENGTH_LONG).show()
        startLogging()
    }
    private val backgroundPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val root = findViewById<android.view.View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        settings = Settings(this)
        status = findViewById(R.id.status)
        val url = findViewById<EditText>(R.id.serverUrl).apply { setText(settings.serverUrl) }
        val token = findViewById<EditText>(R.id.token).apply { setText(settings.token) }
        val device = findViewById<EditText>(R.id.device).apply { setText(settings.device) }

        findViewById<Button>(R.id.save).setOnClickListener {
            val problem = Settings.validUrl(url.text.toString())
            if (problem != null) { url.error = problem; return@setOnClickListener }
            if (token.text.isBlank()) { token.error = "Paste the server's INGEST_TOKEN"; return@setOnClickListener }
            settings.serverUrl = url.text.toString()
            settings.token = token.text.toString()
            settings.device = device.text.toString()
            device.setText(settings.device)
            Toast.makeText(this, "Saved" + if (settings.running) ". Applies to the next upload." else "", Toast.LENGTH_SHORT).show()
            render()
        }
        findViewById<Button>(R.id.toggle).setOnClickListener {
            if (settings.running) { SensorService.stop(this); ui.postDelayed({ render() }, 300) } else askLocation()
        }
        findViewById<Button>(R.id.background).setOnClickListener { askBackground() }
        findViewById<Button>(R.id.battery).setOnClickListener {
            // Opens the system list; we don't request a battery-optimisation exemption ourselves.
            startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    override fun onResume() { super.onResume(); ui.post(refresher) }
    override fun onPause() { ui.removeCallbacks(refresher); super.onPause() }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun askLocation() {
        if (!settings.configured) { Toast.makeText(this, "Save a https server URL and token first.", Toast.LENGTH_LONG).show(); return }
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) return askNotifications()
        val ask = { locationPerms.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }
        if (shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)) {
            AlertDialog.Builder(this).setTitle("Location")
                .setMessage("phone-robot records your precise location every 10 seconds while logging is on, and sends it only to the server you set.")
                .setPositiveButton("Continue") { _, _ -> ask() }.setNegativeButton("Cancel", null).show()
        } else ask()
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) notificationPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        else askActivity()
    }

    private fun askActivity() {
        if (Build.VERSION.SDK_INT >= 29 && !granted(Manifest.permission.ACTIVITY_RECOGNITION)) activityPerm.launch(Manifest.permission.ACTIVITY_RECOGNITION)
        else startLogging()
    }

    private fun startLogging() {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) return
        SensorService.start(this)
        ui.postDelayed({ render() }, 300)
    }

    private fun askBackground() {
        if (Build.VERSION.SDK_INT < 29) { Toast.makeText(this, "Not needed on this Android version.", Toast.LENGTH_SHORT).show(); return }
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            Toast.makeText(this, "Allow location first (press Start logging).", Toast.LENGTH_LONG).show(); return
        }
        if (granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) { Toast.makeText(this, "Already allowed all the time.", Toast.LENGTH_SHORT).show(); return }
        AlertDialog.Builder(this).setTitle("Location all the time (optional)")
            .setMessage("Logging with the screen off already works without this. It only matters if Android stops the app and restarts it later: then the service may resume logging on its own.\n\nOn the next screen choose \"Allow all the time\".")
            .setPositiveButton("Continue") { _, _ -> backgroundPerm.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
            .setNegativeButton("Not now", null).show()
    }

    private fun deniedDialog(what: String, why: String, perm: String) {
        val permanent = !shouldShowRequestPermissionRationale(perm)
        val b = AlertDialog.Builder(this).setTitle("$what not allowed").setMessage(why + if (permanent) "\n\nYou can allow it in app settings." else "")
        if (permanent) b.setPositiveButton("App settings") { _, _ ->
            startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
        b.setNegativeButton("OK", null).show()
    }

    private fun render() {
        findViewById<Button>(R.id.toggle).setText(if (settings.running) R.string.stop else R.string.start)
        val perms = buildList {
            add("location: " + when {
                granted(Manifest.permission.ACCESS_FINE_LOCATION) -> "precise"
                granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> "approximate"
                else -> "not allowed"
            } + if (Build.VERSION.SDK_INT >= 29 && granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) ", all the time" else "")
            if (Build.VERSION.SDK_INT >= 29) add("activity: " + if (granted(Manifest.permission.ACTIVITY_RECOGNITION)) "allowed" else "not allowed")
            if (Build.VERSION.SDK_INT >= 33) add("notifications: " + if (granted(Manifest.permission.POST_NOTIFICATIONS)) "allowed" else "not allowed")
        }
        val queued = File(filesDir, "queue").listFiles { f -> f.name.startsWith("batch-") }?.size ?: 0
        status.text = buildString {
            appendLine("service:     ${settings.status("service").ifEmpty { "stopped" }}")
            appendLine("last sample: ${settings.status("lastSample").ifEmpty { "—" }}")
            appendLine("last upload: ${settings.status("lastUpload").ifEmpty { "—" }}")
            appendLine("upload:      ${settings.status("upload").ifEmpty { "—" }}")
            appendLine("queued:      $queued batch(es) of up to 6 samples")
            appendLine("location:    ${settings.status("location").ifEmpty { "—" }}")
            appendLine("activity:    ${settings.status("activity").ifEmpty { "—" }}  now=${ActivityState.current ?: "?"}")
            appendLine("motion:      ${settings.status("motion").ifEmpty { "—" }}")
            appendLine()
            perms.forEach { appendLine(it) }
        }
    }
}
