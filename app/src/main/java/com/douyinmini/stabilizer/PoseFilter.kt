package com.douyinmini.stabilizer

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * 1 Euro 式自适应滤波（移植自 3dof-test）。
 * cutoff = minCutoff + beta·speed：静止压抖，转动抬高截止换低延迟。
 * 同时对外暴露平滑角速度 speedDeg，供云台速度门控使用。
 */
class PoseFilter(
    @Volatile var minCutoff: Double = 1.5,
    @Volatile var beta: Double = 0.20,
) {
    private var neutral: Q? = null
    private var previousTime = 0L
    private var previousRaw = Q.IDENTITY
    private var filtered = Q.IDENTITY
    private var velocity = 0.0
    var relativeOrientation = Q.IDENTITY
        private set

    /** 平滑后的头部角速度（deg/s），GL 线程读取用于云台速度门控 */
    @Volatile var speedDeg = 0.0
        private set

    fun reset() {
        neutral = null; previousTime = 0; previousRaw = Q.IDENTITY
        filtered = Q.IDENTITY; relativeOrientation = Q.IDENTITY; velocity = 0.0; speedDeg = 0.0
    }

    fun read(raw: Q, timeNanos: Long): Q? {
        val norm = raw.norm()
        if (!norm.isFinite() || norm < 1e-12 || timeNanos <= previousTime) return null
        val q = raw * (1 / norm)
        if (neutral == null) neutral = q
        val delta = neutral!!.inverse() * q          // 相对零位姿态 = 世界锚定的“世界”
        relativeOrientation = delta
        val dt = if (previousTime == 0L) .01 else (timeNanos - previousTime) / 1e9
        var difference = previousRaw.inverse() * delta
        if (difference.w < 0) difference = difference * -1.0
        val vectorLength = sqrt(difference.x * difference.x + difference.y * difference.y + difference.z * difference.z)
        val angleDeg = if (vectorLength < 1e-12) 0.0 else 2 * atan2(vectorLength, difference.w) * 180 / PI
        val derivativeAlpha = 1 / (1 + 1 / (2 * PI * dt))
        velocity += derivativeAlpha * (angleDeg / dt - velocity)   // 平滑后的角速度（deg/s）
        speedDeg = velocity
        val cutoff = minCutoff + beta * velocity                   // 速度自适应截止频率（Hz）
        val alpha = if (previousTime == 0L) 1.0 else 1 / (1 + 1 / (2 * PI * cutoff * dt))
        filtered = filtered.slerp(delta, alpha)
        previousRaw = delta; previousTime = timeNanos
        return filtered
    }
}
