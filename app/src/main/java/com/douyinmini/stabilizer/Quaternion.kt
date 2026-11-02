package com.douyinmini.stabilizer

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 四元数（云台防抖世界锚定所需的全部运算，移植自 3dof-test）。
 */
class Q(val x: Double, val y: Double, val z: Double, val w: Double) {
    operator fun times(b: Q) = Q(
        w * b.x + x * b.w + y * b.z - z * b.y,
        w * b.y - x * b.z + y * b.w + z * b.x,
        w * b.z + x * b.y - y * b.x + z * b.w,
        w * b.w - x * b.x - y * b.y - z * b.z,
    )
    operator fun times(s: Double) = Q(x * s, y * s, z * s, w * s)
    fun inverse() = Q(-x, -y, -z, w)
    fun norm() = sqrt(x * x + y * y + z * z + w * w)
    fun dot(b: Q) = x * b.x + y * b.y + z * b.z + w * b.w
    fun angularDistance(b: Q) = 2 * acos(abs(dot(b)).coerceIn(0.0, 1.0)) * 180 / PI
    fun slerp(other: Q, alpha: Double): Q {
        val b = if (dot(other) < 0) other * -1.0 else other
        val cosine = dot(b).coerceIn(0.0, 1.0)
        val aw: Double; val bw: Double
        if (cosine > .9995) { aw = 1 - alpha; bw = alpha }
        else {
            val angle = acos(cosine)
            aw = sin((1 - alpha) * angle) / sin(angle)
            bw = sin(alpha * angle) / sin(angle)
        }
        val r = Q(x * aw + b.x * bw, y * aw + b.y * bw, z * aw + b.z * bw, w * aw + b.w * bw)
        return r * (1 / r.norm())
    }

    /** Android 视向为 -Z，渲染空间画面在 +Z：翻转 x/y 即完成坐标系转换。 */
    fun inRenderSpace() = Q(-x, -y, z, w)

    companion object {
        val IDENTITY = Q(0.0, 0.0, 0.0, 1.0)
        fun axisAngle(x: Double, y: Double, z: Double, angle: Double): Q {
            val s = sin(angle / 2)
            return Q(x * s, y * s, z * s, cos(angle / 2))
        }
    }
}
