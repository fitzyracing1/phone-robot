package com.fitzyracing1.phonerobot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/** Receives Activity Recognition transition events and hands them to [ActivityState]. */
class ActivityTransitionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val nowWall = System.currentTimeMillis()
        val nowElapsed = SystemClock.elapsedRealtimeNanos()
        for (e in result.transitionEvents) {
            val t = nowWall - (nowElapsed - e.elapsedRealTimeNanos) / 1_000_000
            val type = if (e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) "ENTER" else "EXIT"
            ActivityState.record(Transition(ActivityState.name(e.activityType), type, t))
        }
    }
}

/** Process-wide current activity plus transitions not yet written into a sample. */
object ActivityState {
    val TRACKED = intArrayOf(DetectedActivity.STILL, DetectedActivity.WALKING, DetectedActivity.RUNNING, DetectedActivity.ON_BICYCLE, DetectedActivity.IN_VEHICLE)

    @Volatile var current: String? = null
        private set
    private val pending = mutableListOf<Transition>()
    @Volatile var listener: ((String?) -> Unit)? = null

    fun name(type: Int): String = when (type) {
        DetectedActivity.IN_VEHICLE -> "IN_VEHICLE"
        DetectedActivity.ON_BICYCLE -> "ON_BICYCLE"
        DetectedActivity.ON_FOOT -> "ON_FOOT"
        DetectedActivity.RUNNING -> "RUNNING"
        DetectedActivity.STILL -> "STILL"
        DetectedActivity.TILTING -> "TILTING"
        DetectedActivity.WALKING -> "WALKING"
        else -> "UNKNOWN"
    }

    @Synchronized
    fun record(t: Transition) {
        pending.add(t)
        if (pending.size > 20) pending.removeAt(0)
        val before = current
        if (t.type == "ENTER") current = t.activity
        else if (current == t.activity) current = null
        if (before != current) listener?.invoke(current)
    }

    @Synchronized
    fun drain(): List<Transition> = pending.toList().also { pending.clear() }

    @Synchronized
    fun reset() { pending.clear(); current = null }
}
