package com.fitzyracing1.phonerobot

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Running summary of one sensor's vector magnitude over a window.
 * For the accelerometer, [reference] is gravity: rms and peak describe how far |a| strays from 1 g (i.e. how much
 * the phone is shaking or accelerating). For the gyroscope the reference is 0, so rms/peak are rotation speed.
 */
class MotionStats(private val reference: Double) {
    private var n = 0
    private var sum = 0.0
    private var sumSqDev = 0.0
    private var peak = 0.0

    @Synchronized
    fun add(x: Float, y: Float, z: Float) {
        val mag = sqrt((x * x + y * y + z * z).toDouble())
        val dev = mag - reference
        n++
        sum += mag
        sumSqDev += dev * dev
        if (abs(dev) > peak) peak = abs(dev)
    }

    data class Snapshot(val n: Int, val mean: Double, val rms: Double, val peak: Double)

    /** Return the window so far and start a new one. Null when no events arrived. */
    @Synchronized
    fun drain(): Snapshot? {
        if (n == 0) return null
        val s = Snapshot(n, sum / n, sqrt(sumSqDev / n), peak)
        n = 0; sum = 0.0; sumSqDev = 0.0; peak = 0.0
        return s
    }

    companion object {
        const val GRAVITY = 9.80665
    }
}
