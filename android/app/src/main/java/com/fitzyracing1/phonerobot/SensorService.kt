package com.fitzyracing1.phonerobot

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.io.File
import java.text.DateFormat
import java.util.Date

/**
 * Foreground service (type "location") that writes one sample every 10 s:
 *  - the latest Fused Location fix (high accuracy while moving, balanced while STILL),
 *  - the current activity and any Activity Recognition transitions since the last sample,
 *  - an accelerometer + gyroscope summary for the window (50 Hz, batched in the sensor hub),
 *  - battery level.
 * Samples go to [SampleQueue] on disk; [Uploader] sends batches when there's a network.
 *
 * Power: no wake locks. The 10 s clock is a Handler on a worker thread, nudged by the location callback, which is what
 * wakes the CPU while the screen is off. Motion sensors use a 10 s maxReportLatency so the sensor hub buffers events
 * instead of waking the CPU 50 times a second.
 */
class SensorService : Service(), SensorEventListener {
    companion object {
        const val ACTION_START = "com.fitzyracing1.phonerobot.START"
        const val ACTION_STOP = "com.fitzyracing1.phonerobot.STOP"
        const val ACTION_POLL = "com.fitzyracing1.phonerobot.POLL"
        const val TICK_MS = 10_000L
        private const val CHANNEL = "logging"
        private const val NOTIF_ID = 1
        private const val TAG = "phone-robot"
        private const val SENSOR_PERIOD_US = 20_000 // 50 Hz
        private const val SENSOR_LATENCY_US = 10_000_000 // let the hub batch up to 10 s

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, SensorService::class.java).setAction(ACTION_START))
        fun stop(context: Context) = context.startService(Intent(context, SensorService::class.java).setAction(ACTION_STOP))
        private const val PAUSED_INTERVAL_MS = 60_000L
        private const val MSG_CHANNEL = "messages"
    }

    private lateinit var settings: Settings
    private lateinit var queue: SampleQueue
    private lateinit var uploader: Uploader
    private lateinit var thread: HandlerThread
    private lateinit var worker: Handler
    private lateinit var fused: FusedLocationProviderClient
    private lateinit var sensors: SensorManager

    private val accel = MotionStats(MotionStats.GRAVITY)
    private val gyro = MotionStats(0.0)
    @Volatile private var lastFix: Fix? = null
    private var lastTickElapsed = 0L
    private var started = false
    private var highAccuracy: Boolean? = null
    private var transitionsPending: PendingIntent? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var samples = 0
    private lateinit var commandClient: CommandClient
    private val seen = SeenIds()
    private val pendingAcks = mutableListOf<Ack>()
    private var lastPollElapsed = 0L
    private var pollEveryMs = 60_000L
    private var paused = false
    private var notifId = 100
    private var lastAppliedPaused: Boolean? = null

    private val tick = object : Runnable {
        override fun run() {
            maybeSample()
            worker.postDelayed(this, TICK_MS)
        }
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { l ->
                lastFix = Fix(
                    l.latitude, l.longitude,
                    if (l.hasAccuracy()) l.accuracy else null,
                    if (l.hasAltitude()) l.altitude else null,
                    if (l.hasSpeed()) l.speed else null,
                    if (l.hasBearing()) l.bearing else null,
                    l.time,
                )
            }
            if (paused) maybePoll() else maybeSample()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        queue = SampleQueue(File(filesDir, "queue"))
        thread = HandlerThread("phone-robot-worker").also { it.start() }
        worker = Handler(thread.looper)
        uploader = Uploader(queue, settings, worker)
        fused = LocationServices.getFusedLocationProviderClient(this)
        sensors = getSystemService(SENSOR_SERVICE) as SensorManager
        commandClient = CommandClient(settings)
        seen.restore(settings.seenCommands)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_POLL) {
            // FCM nudge while running: fetch commands now. If we weren't running, there's nothing to poll with.
            if (started) worker.post { pollCommands(force = true) } else stopSelf()
            return if (started) START_STICKY else START_NOT_STICKY
        }
        if (!hasFineOrCoarse()) {
            Log.w(TAG, "no location permission; not starting")
            settings.putStatus("service", "stopped: location permission missing")
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, notification(), if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
        } catch (e: Exception) {
            // Android 12+ refuses to start a location FGS from the background without "all the time" location.
            Log.w(TAG, "startForeground refused: $e")
            settings.putStatus("service", "stopped: Android refused to start in the background (${e.javaClass.simpleName})")
            settings.running = false
            stopSelf()
            return START_NOT_STICKY
        }
        if (!started) begin() else if (paused) worker.post { resume("started from the app") }
        // If Android kills the process, restart it; with "all the time" location it can resume logging.
        return START_STICKY
    }

    private fun begin() {
        started = true
        settings.running = true
        settings.putStatus("service", "running since " + DateFormat.getTimeInstance().format(Date()))
        ActivityState.listener = { worker.post { applyLocationPriority() } }
        paused = false
        settings.paused = false
        applyLocationPriority()
        startTransitions()
        startSensors()
        startNetworkWatch()
        lastTickElapsed = SystemClock.elapsedRealtime()
        worker.postDelayed(tick, TICK_MS)
        uploader.kick()
        worker.post { pollCommands(force = true) }
        registerFcmToken()
    }

    // ---------- milestone 2: remote commands ----------

    /** Poll at most every pollSeconds (server-suggested, 60 s) unless forced (FCM nudge, start-up). */
    private fun maybePoll() {
        if (SystemClock.elapsedRealtime() - lastPollElapsed >= pollEveryMs - 1_000) pollCommands(force = false)
    }

    private fun pollCommands(force: Boolean) {
        if (!started || !settings.configured) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastPollElapsed < 15_000) return
        lastPollElapsed = now
        try {
            if (pendingAcks.isNotEmpty() && commandClient.ack(pendingAcks.toList())) pendingAcks.clear()
            val poll = commandClient.poll() ?: run { settings.putStatus("commands", "server has no /commands (milestone 1 server)"); return }
            pollEveryMs = poll.pollSeconds * 1000L
            val acks = mutableListOf<Ack>()
            for (c in poll.commands) {
                if (!seen.firstTime(c.id)) { acks.add(Ack(c.id, true)); continue } // already handled; the earlier ack was lost
                acks.add(handle(c))
            }
            settings.seenCommands = seen.snapshot()
            if (acks.isNotEmpty() && !commandClient.ack(acks)) pendingAcks.addAll(acks)
            settings.putStatus("commands", "polled " + DateFormat.getTimeInstance().format(Date()) + if (poll.commands.isNotEmpty()) " (${poll.commands.size} handled)" else "")
        } catch (e: Exception) {
            settings.putStatus("commands", "poll failed: ${e.javaClass.simpleName}")
        }
    }

    private fun handle(c: Command): Ack = when (c.type) {
        "start" -> { resume("remote start"); Ack(c.id, true, org.json.JSONObject().put("state", "logging")) }
        "stop" -> { pause(c.args["reason"] ?: "remote stop"); Ack(c.id, true, org.json.JSONObject().put("state", "paused")) }
        "ping" -> Ack(c.id, true, statusJson())
        "notify" -> {
            val shown = showMessage(c.args["title"] ?: "phone-robot", c.args["body"] ?: "")
            Ack(c.id, shown, org.json.JSONObject().put("shown", shown).apply { if (!shown) put("error", "notifications not allowed") })
        }
        else -> Ack(c.id, false, org.json.JSONObject().put("error", "unknown command"))
    }

    private fun statusJson(): org.json.JSONObject {
        val bm = getSystemService(BATTERY_SERVICE) as BatteryManager
        return org.json.JSONObject()
            .put("state", if (paused) "paused" else "logging")
            .put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", bm.isCharging)
            .put("queued", queue.size())
            .put("fixAgeS", lastFix?.let { (System.currentTimeMillis() - it.t) / 1000 } ?: -1)
            .put("activity", ActivityState.current ?: "UNKNOWN")
            .put("app", BuildConfig.VERSION_NAME)
            .put("fcm", BuildConfig.FCM_ENABLED)
    }

    /** Remote stop: no samples, no motion sensors, location at low power every 60 s just to stay reachable. */
    @SuppressLint("MissingPermission")
    private fun pause(reason: String) {
        if (paused) return
        paused = true
        settings.paused = true
        worker.removeCallbacks(tick)
        sensors.unregisterListener(this)
        accel.drain(); gyro.drain()
        queue.seal()
        uploader.kick(force = true)
        if (hasFineOrCoarse()) {
            fused.removeLocationUpdates(locationCallback)
            val req = LocationRequest.Builder(Priority.PRIORITY_LOW_POWER, PAUSED_INTERVAL_MS).setMinUpdateIntervalMillis(PAUSED_INTERVAL_MS / 2).build()
            fused.requestLocationUpdates(req, locationCallback, thread.looper)
            highAccuracy = null
        }
        settings.putStatus("service", "paused remotely: ${reason.take(80)}")
        updateNotification()
    }

    private fun resume(reason: String) {
        if (!paused) return
        paused = false
        settings.paused = false
        applyLocationPriority()
        startSensors()
        lastTickElapsed = SystemClock.elapsedRealtime()
        worker.removeCallbacks(tick)
        worker.postDelayed(tick, TICK_MS)
        settings.putStatus("service", "running ($reason) since " + DateFormat.getTimeInstance().format(Date()))
        updateNotification()
    }

    private fun showMessage(title: String, body: String): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(MSG_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(MSG_CHANNEL, getString(R.string.msg_channel_name), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = getString(R.string.msg_channel_desc)
            })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(notifId++, NotificationCompat.Builder(this, MSG_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_robot)
            .setContentTitle(title.take(60))
            .setContentText(body.take(240))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(240)))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build())
        if (notifId > 150) notifId = 100
        return true
    }

    private fun updateNotification() {
        if (lastAppliedPaused == paused) return
        lastAppliedPaused = paused
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, notification())
    }

    private fun registerFcmToken() {
        if (!BuildConfig.FCM_ENABLED) return
        try {
            if (com.google.firebase.FirebaseApp.getApps(this).isEmpty()) return
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
                worker.post { try { settings.putStatus("fcm", if (commandClient.registerFcm(t)) "registered" else "register failed") } catch (e: Exception) { settings.putStatus("fcm", "register failed: ${e.javaClass.simpleName}") } }
            }
        } catch (e: Exception) {
            settings.putStatus("fcm", "unavailable: ${e.javaClass.simpleName}")
        }
    }

    private fun hasFineOrCoarse() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun hasActivityRecognition() =
        Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

    /** GPS while moving; Wi-Fi/cell-level accuracy while STILL. Same 10 s cadence either way. */
    @SuppressLint("MissingPermission")
    private fun applyLocationPriority() {
        if (!hasFineOrCoarse()) return
        val wantHigh = ActivityState.current != "STILL"
        if (highAccuracy == wantHigh) return
        highAccuracy = wantHigh
        val req = LocationRequest.Builder(if (wantHigh) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY, TICK_MS)
            .setMinUpdateIntervalMillis(TICK_MS / 2)
            .setWaitForAccurateLocation(false)
            .build()
        fused.removeLocationUpdates(locationCallback)
        fused.requestLocationUpdates(req, locationCallback, thread.looper)
            .addOnFailureListener { settings.putStatus("location", "location request failed: ${it.message}") }
        settings.putStatus("location", if (wantHigh) "high accuracy (moving)" else "balanced (still)")
    }

    @SuppressLint("MissingPermission")
    private fun startTransitions() {
        if (!hasActivityRecognition()) { settings.putStatus("activity", "off: activity recognition permission not granted"); return }
        val transitions = ActivityState.TRACKED.flatMap { a ->
            listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map {
                ActivityTransition.Builder().setActivityType(a).setActivityTransition(it).build()
            }
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pi = PendingIntent.getBroadcast(this, 0, Intent(this, ActivityTransitionReceiver::class.java), flags)
        transitionsPending = pi
        ActivityRecognition.getClient(this).requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pi)
            .addOnSuccessListener { settings.putStatus("activity", "on") }
            .addOnFailureListener { settings.putStatus("activity", "failed: ${it.message}") }
    }

    private fun startSensors() {
        val handler = Handler(thread.looper)
        val a = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val g = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        a?.let { sensors.registerListener(this, it, SENSOR_PERIOD_US, SENSOR_LATENCY_US, handler) }
        g?.let { sensors.registerListener(this, it, SENSOR_PERIOD_US, SENSOR_LATENCY_US, handler) }
        settings.putStatus("motion", "accelerometer ${if (a != null) "on" else "missing"}, gyroscope ${if (g != null) "on" else "missing"}")
    }

    override fun onSensorChanged(event: SensorEvent) {
        val v = event.values
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> accel.add(v[0], v[1], v[2])
            Sensor.TYPE_GYROSCOPE -> gyro.add(v[0], v[1], v[2])
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun startNetworkWatch() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { uploader.kick(force = true) }
        }
        cm.registerDefaultNetworkCallback(cb, Handler(thread.looper))
        netCallback = cb
    }

    /** Write a sample if ~10 s have passed (called from the Handler tick and from each location callback). */
    private fun maybeSample() {
        if (!started || paused) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastTickElapsed < TICK_MS - 1_000) return
        lastTickElapsed = now
        val fix = lastFix?.takeIf { System.currentTimeMillis() - it.t < 60_000 }
        val bm = getSystemService(BATTERY_SERVICE) as BatteryManager
        val battery = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
        val charging = bm.isCharging
        val sample = SampleJson.sample(System.currentTimeMillis(), fix, ActivityState.current, ActivityState.drain(), accel.drain(), gyro.drain(), battery, charging)
        val sealed = queue.add(sample.toString())
        samples++
        settings.putStatus("lastSample", DateFormat.getTimeInstance().format(Date()) + (if (fix == null) " (no fix yet)" else ""))
        settings.putStatus("queued", queue.size().toString())
        if (sealed) {
            uploader.kick()
            worker.post { pollCommands(force = false) } // commands ride the upload cycle (about once a minute)
        }
    }

    private fun shutdown() {
        if (started) {
            started = false
            worker.removeCallbacks(tick)
            fused.removeLocationUpdates(locationCallback)
            transitionsPending?.let { pi ->
                try { ActivityRecognition.getClient(this).removeActivityTransitionUpdates(pi) } catch (_: SecurityException) { /* permission revoked meanwhile */ }
                pi.cancel()
            }
            sensors.unregisterListener(this)
            netCallback?.let { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
            ActivityState.listener = null
            ActivityState.reset()
            paused = false
            settings.paused = false
            queue.seal()
            uploader.kick(force = true) // one last attempt; the queue persists if it fails
        }
        settings.running = false
        settings.putStatus("service", "stopped")
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (started) shutdown()
        // Give the final upload a moment, then end the worker thread.
        worker.postDelayed({ thread.quitSafely() }, 15_000)
        super.onDestroy()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_desc)
                setShowBadge(false)
            })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, SensorService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_robot)
            .setContentTitle(getString(if (paused) R.string.notif_paused else R.string.notif_title))
            .setContentText(if (paused) getString(R.string.notif_paused_text) else "Every 10 s → ${Settings(this).serverUrl.removePrefix("https://")}")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notif_stop), stop)
            .build()
    }
}
