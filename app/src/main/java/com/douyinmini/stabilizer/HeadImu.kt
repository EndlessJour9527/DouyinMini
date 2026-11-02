package com.douyinmini.stabilizer

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.os.Process
import android.view.Surface
import kotlin.math.PI

/**
 * 头部姿态来源（移植自 3dof-test 的 Imu）：
 * Game Rotation Vector（陀螺仪+加速度计融合，无磁力计 → yaw 缓慢漂移，可重置零位）。
 * 传感器回调在专用线程；首个有效样本即零位。
 */
class HeadImu(context: Context, private val rotation: () -> Int) : SensorEventListener {
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    val filter = PoseFilter()
    private val quaternionValues = FloatArray(4)
    private val predictor = PosePredictor()
    private val sensor = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
        ?: manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private var samplingPeriodMicros = 10_000
    @Volatile var sample: PoseSample? = null
        private set

    /** 相对零位的滤波后姿态，GL 线程每帧读取。 */
    @Volatile var orientation = Q.IDENTITY
        private set

    fun start(): Boolean {
        if (thread != null) return true
        val sensor = sensor ?: return false
        filter.reset(); predictor.reset(); sample = null; orientation = Q.IDENTITY
        thread = HandlerThread("gimbal-stab-imu", Process.THREAD_PRIORITY_DISPLAY).also { it.start() }
        handler = Handler(thread!!.looper)
        val ok = manager.registerListener(this, sensor, samplingPeriodMicros, 0, handler)
        if (!ok) stop()
        return ok
    }

    fun setFastSampling(fast: Boolean) {
        samplingPeriodMicros = if (fast) 5_000 else 10_000
        if (thread != null && sensor != null) {
            manager.registerListener(this, sensor, samplingPeriodMicros, 0, handler)
        }
    }

    /** 重校准：零位回到当前朝向（在传感器线程执行，避免与滤波状态竞争）。 */
    fun reset() { handler?.post { filter.reset(); predictor.reset(); sample = null; orientation = Q.IDENTITY } }

    fun stop() {
        manager.unregisterListener(this)
        val oldThread = thread
        thread = null; handler = null
        oldThread?.quitSafely()
        oldThread?.join()
        sample = null
        orientation = Q.IDENTITY
    }

    override fun onSensorChanged(event: SensorEvent) {
        // Sensor timestamps include deep sleep; Choreographer and EGL use uptime.
        val sampleUptime = sensorTimeToUptime(event.timestamp,
            SystemClock.elapsedRealtimeNanos(), System.nanoTime()) ?: return
        val values = quaternionValues
        SensorManager.getQuaternionFromVector(values, event.values)   // Android 返回 w,x,y,z
        var raw = Q(values[1].toDouble(), values[2].toDouble(), values[3].toDouble(), values[0].toDouble())
        // 屏幕方向补偿：显示旋转多少度，坐标系就反向转多少度。
        raw = when (rotation()) {
            Surface.ROTATION_90 -> raw * Q.axisAngle(0.0, 0.0, 1.0, PI / 2)
            Surface.ROTATION_180 -> raw * Q.axisAngle(0.0, 0.0, 1.0, PI)
            Surface.ROTATION_270 -> raw * Q.axisAngle(0.0, 0.0, 1.0, -PI / 2)
            else -> raw
        }
        val pose = filter.read(raw, event.timestamp) ?: return
        orientation = pose
        sample = predictor.update(filter.relativeOrientation, pose, sampleUptime, filter.speedDeg)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
