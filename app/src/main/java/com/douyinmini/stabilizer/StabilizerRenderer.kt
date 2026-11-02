package com.douyinmini.stabilizer

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLDisplay
import android.opengl.GLES30
import android.util.Log
import android.os.Build
import android.os.Process
import android.opengl.EGLExt
import java.util.concurrent.atomic.AtomicInteger
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.Surface
import kotlin.math.PI
import kotlin.math.tan

/**
 * GL 线程（移植自 3dof-test 的 WebGlThread）：
 * 消费 WebView 离屏帧纹理，做 3DOF 速度门控跟随投影，输出到 SurfaceView。
 */
class StabilizerRenderer(
    private val displaySurface: Surface,
    private val displayWidth0: Int,
    private val displayHeight0: Int,
    private val pose: () -> PoseSample?,
    initialMode: StabilizerMode,
    initialQualityEnhanced: Boolean,
    private val refreshPeriodNanos: Long,
    private val onSurfaceTextureReady: (SurfaceTexture) -> Unit,
) : Thread("gimbal-stab-gl") {
    internal val inputGate = FrameGate()
    @Volatile private var renderHandler: Handler? = null

    @Volatile private var running = true
    @Volatile private var displayWidth = displayWidth0
    @Volatile private var displayHeight = displayHeight0
    private val fovXDegrees = 20.0

    @Volatile var mode = initialMode
    @Volatile var qualityEnhanced = initialQualityEnhanced
    @Volatile var readyCaptureScale = captureScale(initialQualityEnhanced)
        private set
    private val recenterVersion = AtomicInteger()
    private val controller = OrientationController()
    private var totalFrames = 0L
    private var statsStart = 0L
    private var textureFrames = 0L

    fun recenter() { recenterVersion.incrementAndGet() }

    private var viewTanX = 0.0; private var viewTanY = 0.0
    private var photoTanX = 0.0; private var photoTanY = 0.0

    companion object {
        /**
         * 虚拟屏尺寸倍率：1.0 = 与原生显示严格 1:1（画面铺满 480×380，不缩小）。
         * >1 时 WebView 内容放大填满纹理，虚拟屏比视口更大（EIS 式裁切防抖余量），
         * 转动时余量更足，代价是画面轻微放大裁边。
         */
        const val OVERSCAN = 1.0
        /** Higher input raster resolution, independent of virtual size/FOV (no zoom/crop). */
        fun captureScale(enhanced: Boolean) = if (enhanced) 1.5f else 1f
    }

    fun setDisplaySize(w: Int, h: Int) {
        displayWidth = w; displayHeight = h
    }

    fun shutdown() {
        running = false
        renderHandler?.post { Looper.myLooper()?.quitSafely() }
    }

    private val vertexShader = """
        #version 300 es
        out vec2 position;
        void main() {
            vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
            position = p * 2.0 - 1.0;
            gl_Position = vec4(position, 0.0, 1.0);
        }
    """.trimIndent()

    // 3DOF 世界锚定：像素视线经头部四元数逆旋转回参考系，与固定窗求交，OES 采样 WebView 帧。
    private val fragmentShader = """
        #version 300 es
        #extension GL_OES_EGL_image_external_essl3 : require
        precision highp float;
        in vec2 position;
        out vec4 outColor;
        uniform vec4 head_rotation;
        uniform vec2 view_tan_half;
        uniform vec2 photo_tan_half;
        uniform samplerExternalOES frame;
        uniform mat4 st_transform;
        uniform bool enhanced_quality;
        vec3 rotate_head(vec3 ray) {
            vec3 t = 2.f * cross(head_rotation.xyz, ray);
            return ray + head_rotation.w * t + cross(head_rotation.xyz, t);
        }
        void main() {
            vec3 ray = rotate_head(vec3(position * view_tan_half, 1.f));
            // Original image-quality path, including the original transparent black border.
            if (!enhanced_quality) {
                if (ray.z <= 1e-6f) { outColor = vec4(0.f); return; }
                vec2 original_uv = (ray.xy / ray.z / photo_tan_half) * .5f + .5f;
                if (any(lessThan(original_uv, vec2(0.f))) || any(greaterThan(original_uv, vec2(1.f)))) {
                    outColor = vec4(0.f); return;
                }
                outColor = vec4(texture(frame, (st_transform * vec4(original_uv, 0.f, 1.f)).xy).rgb, 1.f);
                return;
            }
            vec2 uv = (ray.xy / max(ray.z, 1e-6f) / photo_tan_half) * .5f + .5f;
            // Derivatives must be evaluated before divergent clipping: fragment quads
            // straddling this edge would otherwise have undefined derivatives.
            vec2 edge_width = max(fwidth(uv), vec2(1e-6f));
            if (ray.z <= 1e-6f || any(lessThan(uv, vec2(0.f))) || any(greaterThan(uv, vec2(1.f)))) {
                outColor = vec4(0.f, 0.f, 0.f, 1.f); return;
            }
            // One output-pixel coverage at the projected window edge avoids a binary
            // black/content transition flashing as the boundary crosses subpixels.
            vec2 edge_alpha = smoothstep(vec2(0.f), edge_width, uv) *
                smoothstep(vec2(0.f), edge_width, 1.f - uv);
            vec3 color = texture(frame, (st_transform * vec4(uv, 0.f, 1.f)).xy).rgb;
            float coverage = enhanced_quality ? edge_alpha.x * edge_alpha.y : 1.f;
            outColor = vec4(color * coverage, 1.f);
        }
    """.trimIndent()

    override fun run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
        Looper.prepare()
        val handler = Handler(Looper.myLooper()!!)
        renderHandler = handler
        if (!running) return
        val egl: EGLDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        var eglSurface = EGL14.EGL_NO_SURFACE
        var eglContext = EGL14.EGL_NO_CONTEXT
        var inputTexture: SurfaceTexture? = null
        try {
            check(EGL14.eglInitialize(egl, null, 0, null, 0)) { "eglInitialize failed" }
            val attribs = intArrayOf(
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, 0x40,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
                EGL14.EGL_NONE)
            val configs = arrayOfNulls<EGLConfig>(1)
            val num = IntArray(1)
            check(EGL14.eglChooseConfig(egl, attribs, 0, configs, 0, 1, num, 0) && num[0] > 0) { "No EGL config" }
            eglSurface = EGL14.eglCreateWindowSurface(egl, configs[0], displaySurface,
                intArrayOf(EGL14.EGL_NONE), 0)
            eglContext = EGL14.eglCreateContext(egl, configs[0], EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
            check(EGL14.eglMakeCurrent(egl, eglSurface, eglSurface, eglContext)) { "eglMakeCurrent failed" }

            GLES30.glDisable(GLES30.GL_DITHER)
            val program = buildProgram()
            val frameLocation = GLES30.glGetUniformLocation(program, "frame")
            val headLocation = GLES30.glGetUniformLocation(program, "head_rotation")
            val viewLocation = GLES30.glGetUniformLocation(program, "view_tan_half")
            val photoLocation = GLES30.glGetUniformLocation(program, "photo_tan_half")
            val transformLocation = GLES30.glGetUniformLocation(program, "st_transform")
            val qualityLocation = GLES30.glGetUniformLocation(program, "enhanced_quality")

            val oes = IntArray(1)
            GLES30.glGenTextures(1, oes, 0)
            GLES30.glBindTexture(0x8D65, oes[0])
            GLES30.glTexParameteri(0x8D65, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(0x8D65, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(0x8D65, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
            GLES30.glTexParameteri(0x8D65, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
            val st = SurfaceTexture(oes[0])
            inputTexture = st
            st.setDefaultBufferSize((displayWidth * OVERSCAN * captureScale(qualityEnhanced)).toInt(),
                (displayHeight * OVERSCAN * captureScale(qualityEnhanced)).toInt())
            var texturePending = false
            st.setOnFrameAvailableListener({ texturePending = true }, handler)
            onSurfaceTextureReady(st)          // 交给主线程建 HardwareRenderer 管线

            var lastW = 0; var lastH = 0
            var lastScale = 0f
            val transform = FloatArray(16)

            val choreographer = Choreographer.getInstance()
            var lastRenderedQ = Q.IDENTITY
            fun drawFrame(frameTimeNanos: Long, presentationNanos: Long) {
                if (!running) return
                val newTexture = texturePending
                if (newTexture) {
                    texturePending = false
                    st.updateTexImage()
                    st.getTransformMatrix(transform)
                    textureFrames++
                }
                if (!newTexture && totalFrames == 0L) return

                val w = displayWidth; val h = displayHeight
                val enhanced = qualityEnhanced
                val scale = captureScale(enhanced)
                if (newTexture && (w != lastW || h != lastH || scale != lastScale)) {
                    GLES30.glViewport(0, 0, w, h)
                    // 纹理 = 显示尺寸 × 过扫描倍率；内容等比放大填满（见 GimbalStabilizer 帧回调）
                    st.setDefaultBufferSize((w * OVERSCAN * scale).toInt(),
                        (h * OVERSCAN * scale).toInt())
                    viewTanX = tan(fovXDegrees * PI / 360)
                    viewTanY = viewTanX * h / w
                    // 虚拟屏与视口同大（OVERSCAN=1 时全屏 1:1，不缩小）
                    photoTanX = viewTanX * OVERSCAN
                    photoTanY = viewTanY * OVERSCAN
                    lastW = w; lastH = h
                    lastScale = scale
                    readyCaptureScale = scale
                }
                // Publish buffer dimensions before releasing the producer gate. A quality
                // toggle then cannot record a 480px frame into a 720px buffer (or vice versa).
                if (newTexture) inputGate.onConsumed()
                // Late latch after any texture wait. Warp uses raw fused orientation, while
                // the low-pass target only drives the virtual window's gradual following.
                val sample = pose() ?: return
                val targetTime = maxOf(presentationNanos, System.nanoTime())
                val currentMode = mode
                val head = if (currentMode == StabilizerMode.LEGACY_FOLLOW) sample.followTarget.inRenderSpace()
                    else sample.predict(targetTime).inRenderSpace()
                val q = controller.update(head, sample.followTarget.inRenderSpace(), sample.speedDeg,
                    frameTimeNanos, currentMode, recenterVersion.get())
                // Continue settling the anchor even without a new video frame or IMU event.
                // Read the newest pose at display cadence instead of swapping at sensor cadence.
                if (!newTexture && q.angularDistance(lastRenderedQ) < 0.001) return
                lastRenderedQ = q
                GLES30.glClearColor(0f, 0f, 0f, 1f)
                GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
                GLES30.glUseProgram(program)
                GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
                GLES30.glBindTexture(0x8D65 /* GL_TEXTURE_EXTERNAL_OES */, oes[0])
                GLES30.glUniform1i(frameLocation, 0)
                GLES30.glUniform1i(qualityLocation, if (enhanced) 1 else 0)
                GLES30.glUniform4f(headLocation,
                    q.x.toFloat(), q.y.toFloat(), q.z.toFloat(), q.w.toFloat())
                GLES30.glUniform2f(viewLocation,
                    viewTanX.toFloat(), viewTanY.toFloat())
                GLES30.glUniform2f(photoLocation,
                    photoTanX.toFloat(), photoTanY.toFloat())
                GLES30.glUniformMatrix4fv(
                    transformLocation, 1, false, transform, 0)
                GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
                EGLExt.eglPresentationTimeANDROID(egl, eglSurface, targetTime)
                check(EGL14.eglSwapBuffers(egl, eglSurface)) { "eglSwapBuffers failed" }
                totalFrames++
                if (statsStart == 0L) statsStart = System.nanoTime()
                if (totalFrames % 300L == 0L) {
                    val now = System.nanoTime()
                    val fps = 300.0e9 / (now - statsStart).coerceAtLeast(1)
                    Log.i(GimbalStabilizer.TAG, "mode=${currentMode.id} quality=$enhanced input=${(w * scale).toInt()}x${(h * scale).toInt()} gl frames=$totalFrames " +
                        "fps=%.1f input=$textureFrames poseAgeMs=%.1f offset=%.2f".format(
                            fps, (now - sample.timeNanos) / 1e6, q.angularDistance(Q.IDENTITY)))
                    statsStart = now
                    textureFrames = 0
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val callback = object : Choreographer.VsyncCallback {
                    override fun onVsync(data: Choreographer.FrameData) {
                        if (!running) return
                        choreographer.postVsyncCallback(this)
                        drawFrame(data.frameTimeNanos, data.preferredFrameTimeline.expectedPresentationTimeNanos)
                    }
                }
                if (running) { choreographer.postVsyncCallback(callback); Looper.loop() }
                choreographer.removeVsyncCallback(callback)
            } else {
                val callback = object : Choreographer.FrameCallback {
                    override fun doFrame(frameTimeNanos: Long) {
                        if (!running) return
                        choreographer.postFrameCallback(this)
                        drawFrame(frameTimeNanos, frameTimeNanos + refreshPeriodNanos)
                    }
                }
                if (running) { choreographer.postFrameCallback(callback); Looper.loop() }
                choreographer.removeFrameCallback(callback)
            }
            GLES30.glDeleteTextures(1, oes, 0)
            GLES30.glDeleteProgram(program)
        } catch (e: Throwable) {
            Log.e(GimbalStabilizer.TAG, "gl thread failed", e)
        } finally {
            inputTexture?.setOnFrameAvailableListener(null)
            inputTexture?.release()
            renderHandler = null
            EGL14.eglMakeCurrent(egl, EGL14.EGL_NO_SURFACE,
                EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroySurface(egl, eglSurface)
            EGL14.eglDestroyContext(egl, eglContext)
            EGL14.eglTerminate(egl)
            EGL14.eglReleaseThread()
        }
    }

    private fun compile(kind: Int, source: String): Int {
        val handle = GLES30.glCreateShader(kind)
        GLES30.glShaderSource(handle, source)
        GLES30.glCompileShader(handle)
        val status = IntArray(1)
        GLES30.glGetShaderiv(handle, GLES30.GL_COMPILE_STATUS, status, 0)
        check(status[0] != 0) { GLES30.glGetShaderInfoLog(handle) }
        return handle
    }

    private fun buildProgram(): Int {
        val program = GLES30.glCreateProgram()
        val v = compile(GLES30.GL_VERTEX_SHADER, vertexShader)
        val f = compile(GLES30.GL_FRAGMENT_SHADER, fragmentShader)
        GLES30.glAttachShader(program, v)
        GLES30.glAttachShader(program, f)
        GLES30.glLinkProgram(program)
        val status = IntArray(1)
        GLES30.glGetProgramiv(program, GLES30.GL_LINK_STATUS, status, 0)
        check(status[0] != 0) { GLES30.glGetProgramInfoLog(program) }
        GLES30.glDeleteShader(v)
        GLES30.glDeleteShader(f)
        return program
    }
}
