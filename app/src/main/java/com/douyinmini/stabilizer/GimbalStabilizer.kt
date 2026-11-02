package com.douyinmini.stabilizer

import android.graphics.HardwareRenderer
import android.graphics.RenderNode
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.Surface
import android.view.SurfaceView
import android.view.SurfaceHolder
import android.view.View
import android.webkit.WebView
import com.douyinmini.ui.CaptureWebView

/**
 * 云台防抖门面（管线移植自 3dof-test WebVideoActivity）：
 *
 * 线程模型（attach 后 Chromium 才渲染，draw 必须与窗口同线程）：
 *   主线程: Choreographer 每帧 webView.draw(RenderNode) → HardwareRenderer → SurfaceTexture
 *   GL 线程: updateTexImage → OES 纹理 → 3DOF shader（视线逆旋转 + 固定窗求交）→ SurfaceView
 *
 * 两级开关（性能关键）：
 *   enabled = 用户偏好（快捷菜单「云台防抖」，持久化）
 *   active  = 播放状态闸门（JS 引擎驱动：仅 player 视图且视频播放中才跑管线，
 *             暂停/登录/原生页自动停，回到 ~9% 基线 CPU）
 * 管线仅在 enabled && active 时运行。
 *
 * 开启时 WebView 切 LAYER_TYPE_HARDWARE + alpha=0.99（视频纹理化前提），
 * 关闭时恢复 LAYER_TYPE_NONE（WebViewConfig 默认，普通播放交还视频合成器）。
 * setMode/onVideoFrame 可由桥接线程调用；其余控制方法由主线程调用。
 */
class GimbalStabilizer(
    private val webView: WebView,
    private val outputView: SurfaceView,
    private val rotation: () -> Int,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val imu: HeadImu
    @Volatile private var renderer: StabilizerRenderer? = null

    // 主线程离屏渲染（WebView → SurfaceTexture）
    private var hardwareRenderer: HardwareRenderer? = null
    private var webNode: RenderNode? = null
    private var webSurface: Surface? = null
    private var choreographer: Choreographer? = null

    /** 用户偏好（快捷菜单开关） */
    @Volatile var enabled = false
        private set
    @Volatile var mode = StabilizerMode.LEGACY_FOLLOW
        private set
    @Volatile var qualityEnhanced = true
        private set

    fun setQualityEnhanced(value: Boolean) {
        qualityEnhanced = value
        mainHandler.post {
            if (qualityEnhanced != value) return@post
            renderer?.qualityEnhanced = value
            requestContentRefresh()
        }
    }

    fun setMode(value: StabilizerMode) {
        mode = value
        mainHandler.post {
            if (mode != value) return@post
            imu.setFastSampling(value != StabilizerMode.LEGACY_FOLLOW)
            renderer?.mode = value
            requestContentRefresh()
        }
    }

    fun recenter() { renderer?.recenter() }

    /** Video-frame notification can arrive directly from WebView's bridge thread. */
    fun onVideoFrame() { renderer?.inputGate?.onVideoFrame() }

    fun requestContentRefresh() { renderer?.inputGate?.onUiChanged(System.nanoTime()) }

    /** 播放状态闸门（JS setGimbalActive 驱动），管线实际运行条件 = enabled && active */
    @Volatile var active = true
        private set

    private var pipelineRunning = false
    private var resumed = true
    private var rendererGeneration = 0
    @Volatile private var displayRotation = rotation()

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
            if (!pipelineRunning) return
            val node = webNode ?: return
            val hr = hardwareRenderer ?: return
            val gl = renderer ?: return
            displayRotation = rotation()
            val w = webView.width; val h = webView.height
            if (w > 0 && h > 0 && gl.inputGate.tryAcquire(frameTimeNanos)) {
                // 录制尺寸 = 纹理尺寸（显示 × OVERSCAN）；>1 时内容等比放大铺满，
                // 使虚拟屏比视口大出防抖余量（EIS 式），1.0 则与显示严格 1:1
                val scale = StabilizerRenderer.OVERSCAN.toFloat() * gl.readyCaptureScale
                val tw = (w * scale).toInt(); val th = (h * scale).toInt()
                node.setPosition(0, 0, tw, th)
                val canvas = node.beginRecording(tw, th)
                canvas.scale(scale, scale)
                if (webView is CaptureWebView) webView.drawForCapture(canvas) else webView.draw(canvas)
                node.endRecording()
                hr.createRenderRequest().setVsyncTime(frameTimeNanos)
                    .setWaitForPresent(false).syncAndDraw()
            }
            choreographer?.postFrameCallback(this)
        }
    }

    private val surfaceListener = object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
            if (pipelineRunning) startRenderer(holder.surface, outputView.width, outputView.height)
        }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
            renderer?.setDisplaySize(w, h)
        }
        override fun surfaceDestroyed(holder: SurfaceHolder) {
            stopRenderer()
        }
    }

    init {
        imu = HeadImu(webView.context.applicationContext) { displayRotation }
        outputView.holder.addCallback(surfaceListener)
    }

    /** 用户偏好开关（快捷菜单入口）；传感器不可用时回退并返回 false。 */
    fun setEnabled(on: Boolean): Boolean {
        if (on == enabled) return on
        if (on && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false   // RenderNode/HardwareRenderer 需 API 29
        enabled = on
        if (on) {
            if (active && resumed && !startPipeline()) {
                enabled = false
                stopPipeline()
                Log.w(TAG, "姿态传感器不可用，云台防抖无法开启")
                return false
            }
            Log.i(TAG, "gimbal stabilizer on")
        } else {
            stopPipeline()
            Log.i(TAG, "gimbal stabilizer off")
        }
        return on
    }

    /** 播放状态闸门（JS 驱动，不持久化）：仅 player 播放中跑管线，暂停/其他视图停。 */
    fun setActive(a: Boolean) {
        if (a == active) return
        active = a
        if (!enabled) return
        if (a && resumed) startPipeline() else stopPipeline()
    }

    private fun startPipeline(): Boolean {
        if (pipelineRunning) return true
        if (!imu.start()) return false
        pipelineRunning = true
        // 视频纹理化三保险（之二）：强硬件层 + 微降透明度（之三在注入 CSS 的 translateZ）
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.alpha = 0.99f
        (webView as? CaptureWebView)?.captureOnly = true
        outputView.visibility = View.VISIBLE
        // SurfaceView is consumed directly by SurfaceFlinger, independently of HWUI/WebView.
        if (outputView.holder.surface.isValid) {
            startRenderer(outputView.holder.surface, outputView.width, outputView.height)
        }
        Log.i(TAG, "pipeline start (playback active)")
        return true
    }

    private fun stopPipeline() {
        if (!pipelineRunning) return
        pipelineRunning = false
        imu.stop()
        stopRenderer()
        outputView.visibility = View.GONE
        webView.setLayerType(View.LAYER_TYPE_NONE, null)
        webView.alpha = 1f
        (webView as? CaptureWebView)?.captureOnly = false
        webView.invalidate()
        Log.i(TAG, "pipeline stop (playback idle)")
    }

    fun pause() {
        resumed = false
        stopPipeline()
    }

    fun resume() {
        resumed = true
        if (enabled && active) startPipeline()
    }

    fun destroy() {
        enabled = false
        active = false
        stopPipeline()
    }

    private fun startRenderer(displaySurface: Surface, w: Int, h: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        stopRenderer()
        val generation = rendererGeneration
        val refreshRate = (outputView.display?.refreshRate ?: 60f).coerceAtLeast(1f)
        val thread = StabilizerRenderer(displaySurface, w, h, { imu.sample }, mode, qualityEnhanced,
            (1e9 / refreshRate).toLong(),
            onSurfaceTextureReady = { webSt ->
                // GL 线程已建好 OES 纹理；主线程建离屏渲染链（与窗口 draw 同线程，无竞争）
                mainHandler.post {
                    if (!pipelineRunning || generation != rendererGeneration) return@post
                    webNode = RenderNode("webview").apply { setPosition(0, 0, webView.width, webView.height) }
                    webSurface = Surface(webSt)
                    hardwareRenderer = HardwareRenderer().apply {
                        setSurface(webSurface)
                        setContentRoot(webNode)
                    }
                    choreographer = Choreographer.getInstance().also { it.postFrameCallback(frameCallback) }
                    Log.i(TAG, "web offscreen pipeline ready")
                }
            })
        renderer = thread
        thread.start()
    }

    private fun stopRenderer() {
        rendererGeneration++
        choreographer?.removeFrameCallback(frameCallback); choreographer = null
        // Disconnect the producer before the GL consumer releases its SurfaceTexture.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) hardwareRenderer?.destroy()
        webSurface?.release()
        hardwareRenderer = null; webSurface = null; webNode = null
        renderer?.let {
            it.shutdown()
            // SurfaceHolder requires the drawing thread to stop before surfaceDestroyed returns.
            it.join()
        }
        renderer = null
    }

    companion object {
        const val TAG = "GimbalStab"
    }
}
