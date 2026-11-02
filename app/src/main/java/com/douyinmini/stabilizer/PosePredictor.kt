package com.douyinmini.stabilizer

internal fun sensorTimeToUptime(eventElapsed: Long, elapsedNow: Long, uptimeNow: Long): Long? {
    val age = elapsedNow - eventElapsed
    return if (age in 0L..50_000_000L) uptimeNow - age else null
}

/** Immutable IMU snapshot. All times here use System.nanoTime(), never elapsedRealtimeNanos(). */
data class PoseSample(
    val orientation: Q,
    val followTarget: Q,
    val timeNanos: Long,
    val speedDeg: Double,
    private val step: Q = Q.IDENTITY,
    private val stepNanos: Long = 0,
) {
    fun predict(presentationNanos: Long): Q {
        val age = presentationNanos - timeNanos
        if (stepNanos <= 0 || age <= 0 || age > 50_000_000L) return orientation
        val angle = step.angularDistance(Q.IDENTITY)
        if (angle < 0.00001) return orientation
        // Only short, bounded extrapolation: reversal and stale-sensor overshoot stay limited.
        val factor = minOf(age.coerceAtMost(30_000_000L).toDouble() / stepNanos, 3.0 / angle)
        return orientation * Q.IDENTITY.slerp(step, factor)
    }
}

/** Sensor-thread state; only the returned immutable snapshot crosses to GL. */
internal class PosePredictor {
    private var previous: Q? = null
    private var previousTime = 0L

    fun reset() { previous = null; previousTime = 0L }

    fun update(raw: Q, filtered: Q, timeNanos: Long, speedDeg: Double): PoseSample? {
        val norm = raw.norm()
        if (!norm.isFinite() || norm < 1e-12 || timeNanos <= previousTime) return null
        val pose = raw * (1.0 / norm)
        val dt = timeNanos - previousTime
        var delta = previous?.inverse()?.times(pose) ?: Q.IDENTITY
        if (delta.w < 0) delta = delta * -1.0
        val sample = PoseSample(pose, filtered, timeNanos, speedDeg,
            delta, if (previous != null && dt in 1_000_000L..50_000_000L) dt else 0)
        previous = pose
        previousTime = timeNanos
        return sample
    }
}
