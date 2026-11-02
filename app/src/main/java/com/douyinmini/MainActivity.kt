package com.douyinmini

import android.content.Context
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.addCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.douyinmini.config.WebViewConfig
import com.douyinmini.glasses.GlassesInputManager
import com.douyinmini.stabilizer.GimbalStabilizer
import com.douyinmini.stabilizer.StabilizerMode
import com.douyinmini.ui.ErrorOverlayView
import com.douyinmini.ui.FullscreenVideoLayout
import com.douyinmini.util.NetworkMonitor
import com.douyinmini.util.ThemeUtils
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 显示眼镜 抖音客户端（红果短剧同源签名桥 + 自有播控状态机架构）：
 * - 视口：480x380 px 固定视口（纯黑 #000000 光波导透明背景 + #f35d7b 焦点高亮）
 * - 数据层：WebView 驻留 https://www.douyin.com 同源环境，通过 DOCUMENT_START 注入拦截
 *   window.fetch / XMLHttpRequest / RENDER_DATA，结合 bdms 同源签名自动拉取推荐流与视频详情直链
 * - 视图与交互层（window.HongguoTV）：
 *   1. 全屏单 <video> 播放器（支持下一条预加载、H.264 优先直链与多源自动容错、断点续播）
 *   2. 红果式底部自动隐藏播控栏（图标优先、聚焦展开文字标签）
 *   3. 右侧 210px 快捷命令抽屉（单指长按呼出：切集、倍速、收藏、网格、历史、原生登录/直播模式）
 *   4. 三列紧凑视频网格（推荐流 / 观看历史 / 我的收藏）
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var fullscreenContainer: FullscreenVideoLayout
    private lateinit var errorOverlay: ErrorOverlayView
    private lateinit var hud: TextView
    private lateinit var networkMonitor: NetworkMonitor
    private lateinit var glassesInput: GlassesInputManager
    private lateinit var stabilizer: GimbalStabilizer

    private var mainPageFailed = false

    private val hudHandler = Handler(Looper.getMainLooper())
    private var hudHideRunnable: Runnable? = null

    private val hongguoBootstrapScript: String by lazy { buildHongguoBootstrapScript() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setupImmersiveWindow()
        setupAudioChannel()
        setContentView(R.layout.activity_main)

        initViews()
        configureWebView()
        setupNetworkMonitor()
        setupGlassesInput()
        setupBackPressHandler()
        loadDouyin()
    }

    /**
     * 确保媒体音频通道（STREAM_MUSIC）未静音、音量非零并持有音频焦点，
     * 解决系统提示音正常但 WebView 视频无声的问题。
     */
    private fun setupAudioChannel() {
        volumeControlStream = AudioManager.STREAM_MUSIC
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            if (cur <= 0) {
                val target = (max * 0.5f).toInt().coerceAtLeast(1)
                am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener { }
                    .build()
                am.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            }
        } catch (e: Exception) {
            Log.w(TAG, "setupAudioChannel failed: ${e.message}")
        }
    }

    private fun getStreamVolumePercent(): Int {
        return try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return 60
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(0)
            Math.round((cur * 100.0f) / max).coerceIn(0, 100)
        } catch (_: Exception) {
            60
        }
    }

    private fun adjustStreamVolumeByDelta(delta: Int): Int {
        return try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return getStreamVolumePercent()
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            val step = (max / 10).coerceAtLeast(1)
            val next = if (delta >= 0) (cur + step).coerceAtMost(max) else (cur - step).coerceAtLeast(0)
            am.setStreamVolume(AudioManager.STREAM_MUSIC, next, AudioManager.FLAG_PLAY_SOUND)
            Math.round((next * 100.0f) / max).coerceIn(0, 100)
        } catch (_: Exception) {
            getStreamVolumePercent()
        }
    }

    private fun initViews() {
        webView = findViewById(R.id.webview)
        progressBar = findViewById(R.id.progress_bar)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        hud = findViewById(R.id.hud_gesture)
        errorOverlay = findViewById(R.id.error_overlay)
        errorOverlay.setOnRetryListener { retry() }
        setupGimbalStabilizer()
    }

    /**
     * 云台防抖（3DOF）：快捷菜单「云台防抖」开关驱动，状态持久化。
     * 启动即开启时等首帧布局完成再启用（离屏管线需要 WebView 实际尺寸）。
     */
    private fun setupGimbalStabilizer() {
        stabilizer = GimbalStabilizer(webView, findViewById<SurfaceView>(R.id.stabilizer_surface)) {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }
        val savedMode = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_GIMBAL_MODE, "legacy_follow")
        stabilizer.setMode(StabilizerMode.fromId(savedMode ?: "legacy_follow") ?: StabilizerMode.LEGACY_FOLLOW)
        stabilizer.setQualityEnhanced(getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_GIMBAL_QUALITY, true))
        // 云台防抖默认开启；仅当用户主动关过（存储值为 false）才不启用
        if (getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_GIMBAL_STAB, true)) {
            webView.post { stabilizer.setEnabled(true) }
        }
    }

    private fun configureWebView() {
        WebViewConfig.configure(webView)
        ThemeUtils.forceDark(webView)
        // JS ↔ 原生持久化通道：保存/读取视频队列历史、收藏、播放进度与上次视频 ID
        webView.addJavascriptInterface(NativeBridge(), "DgNative")

        // 在 DOCUMENT_START 阶段注入同源 API 拦截器与红果 UI 引擎，确保首包 /aweme/v1/web/ 请求不漏采
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(
                    webView,
                    hongguoBootstrapScript,
                    setOf("https://*.douyin.com", "https://douyin.com"),
                )
            } catch (e: Exception) {
                Log.w(TAG, "addDocumentStartJavaScript failed: ${e.message}")
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    // 拦截 bytedance:// / snssdk1128:// 等唤醒协议，避免主フレーム跳出
                    return true
                }
                Log.d(TAG, "导航URL: $url")
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                mainPageFailed = false
                Log.d(TAG, "页面开始加载: $url")
                progressBar.visibility = View.VISIBLE
                errorOverlay.hide()
                injectGlassesKit(view)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progressBar.visibility = View.GONE
                if (mainPageFailed) {
                    errorOverlay.show()
                    return
                }
                injectGlassesKit(view)
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                injectGlassesKit(view)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    mainPageFailed = true
                    val code = error?.errorCode ?: -1
                    val desc = error?.description?.toString() ?: "未知错误"
                    Log.w(TAG, "页面加载错误 code=$code desc=$desc url=${request.url}")
                    errorOverlay.show()
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?
            ) {
                val statusCode = errorResponse?.statusCode ?: 0
                if (request?.isForMainFrame == true && statusCode >= 400) {
                    Log.w(TAG, "HTTP错误 status=$statusCode url=${request.url}")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                // The shell already fills the glasses display. Douyin's hidden player can
                // request a separate Android video surface, covering the shell and its menu.
                callback?.onCustomViewHidden()
                Log.d(TAG, "忽略网页全屏请求，保持眼镜播放器和菜单在同一层")
            }

            override fun onHideCustomView() {
                try {
                    fullscreenContainer.hideFullscreen()
                } catch (e: Exception) {
                    Log.e(TAG, "onHideCustomView异常: ${e.message}", e)
                }
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                if (consoleMessage != null &&
                    (consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.ERROR ||
                     consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.WARNING)
                ) {
                    Log.w(TAG, "Console[${consoleMessage.messageLevel()}] line=${consoleMessage.lineNumber()}: ${consoleMessage.message()}")
                }
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?
            ): Boolean {
                return false
            }
        }
    }

    private fun setupNetworkMonitor() {
        networkMonitor = NetworkMonitor(this)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                networkMonitor.isOnline.collect { online ->
                    if (!online) {
                        errorOverlay.show()
                    } else {
                        errorOverlay.hide()
                        if (mainPageFailed || webView.url.isNullOrBlank() || webView.url?.startsWith("chrome-error:") == true) {
                            loadDouyin()
                        }
                    }
                }
            }
        }
    }

    /**
     * 眼镜输入 → window.HongguoTV.glassesGesture(gesture) 统一分发。
     */
    private fun setupGlassesInput() {
        glassesInput = GlassesInputManager(this)
        glassesInput.listener = object : GlassesInputManager.Listener {
            override fun onTouchpadClick() {
                if (errorOverlay.isVisible) {
                    showHud(getString(R.string.hud_retry))
                    retry()
                } else {
                    dispatchGlassesGesture("click")
                }
            }

            override fun onTouchpadDoubleClick() {
                handleBack()
            }

            override fun onTouchpadLongPress() {
                dispatchGlassesGesture("longPress")
            }

            override fun onSwipeForward() {
                dispatchGlassesGesture("swipeForward")
            }

            override fun onSwipeBack() {
                dispatchGlassesGesture("swipeBack")
            }

            override fun onTwoFingerDoubleTap() {
                dispatchGlassesGesture("twoFingerDoubleTap")
            }

            override fun onTempleClick() {
                dispatchGlassesGesture("templeClick")
            }

            override fun onGlassesRemoved() {
                showHud(getString(R.string.hud_glasses_off))
                dispatchGlassesGesture("glassesOff", showFeedback = false)
            }

            override fun onGlassesPutOn() {
                dispatchGlassesGesture("glassesPutOn", showFeedback = false)
            }
        }
    }

    private fun dispatchGlassesGesture(gesture: String, showFeedback: Boolean = true) {
        // A direction-locked window may be outside the view. Long-press brings its menu back.
        if (gesture == "longPress" && stabilizer.enabled && stabilizer.mode == StabilizerMode.ANCHORED) {
            stabilizer.recenter()
        }
        val js = "window.HongguoTV && window.HongguoTV.glassesGesture ? window.HongguoTV.glassesGesture('$gesture') : 'no-bridge'"
        webView.evaluateJavascript(js) { raw ->
            stabilizer.requestContentRefresh()
            Log.d(TAG, "手势执行 $gesture => $raw")
            if (!showFeedback) return@evaluateJavascript
            when (raw?.trim()?.removeSurrounding("\"")) {
                "video-next", "page-next" -> showHud(getString(R.string.hud_next))
                "video-prev", "page-prev" -> showHud(getString(R.string.hud_prev))
                "switching", "loading" -> showHud(getString(R.string.hud_switching))
                "item-next", "bar-next" -> showHud(getString(R.string.hud_item_next))
                "item-prev", "bar-prev" -> showHud(getString(R.string.hud_item_prev))
                "play", "pause" -> showHud(getString(R.string.hud_play_pause))
                "open" -> showHud(getString(R.string.hud_open))
                "seek-b" -> showHud(getString(R.string.hud_seek_b))
                "seek-f" -> showHud(getString(R.string.hud_seek_f))
                "shown" -> showHud(getString(R.string.hud_bar_show))
                "hidden" -> showHud(getString(R.string.hud_bar_hide))
                "menu-open" -> showHud(getString(R.string.hud_menu_open))
                "menu-close" -> showHud(getString(R.string.hud_menu_close))
                "fav-on" -> showHud(getString(R.string.hud_fav_on))
                "fav-off" -> showHud(getString(R.string.hud_fav_off))
                "speed" -> showHud(getString(R.string.hud_speed))
                "autonext-on" -> showHud(getString(R.string.hud_autonext_on))
                "autonext-off" -> showHud(getString(R.string.hud_autonext_off))
                "gimbal-on" -> showHud(getString(R.string.hud_gimbal_on))
                "gimbal-off" -> showHud(getString(R.string.hud_gimbal_off))
                "gimbal-fail" -> showHud(getString(R.string.hud_gimbal_fail))
                "gimbal-legacy_follow" -> showHud("模式 1：原始跟随")
                "gimbal-follow" -> showHud("模式 2：预测跟随")
                "gimbal-anchored" -> showHud("模式 3：方向锚定")
                "gimbal-recenter" -> showHud("3DoF：已回正")
                "gimbal-quality-on" -> showHud("画质优化：开启")
                "gimbal-quality-off" -> showHud("画质优化：关闭")
                "muted", "unmuted" -> showHud(getString(R.string.hud_mute))
                "vol-up", "vol-down" -> showHud("音量 ${getStreamVolumePercent()}%")
                "login-mode" -> showHud(getString(R.string.hud_login_mode))
                "sms-login-mode" -> showHud(getString(R.string.hud_sms_login_mode))
                "qr-refresh" -> showHud(getString(R.string.hud_qr_refresh))
                "qr-zoom-in" -> showHud(getString(R.string.hud_qr_zoom_in))
                "qr-zoom-out" -> showHud(getString(R.string.hud_qr_zoom_out))
                "back-player" -> showHud(getString(R.string.hud_back))
                "exit-confirm" -> showHud(getString(R.string.hud_exit_confirm))
                "exit-app" -> finish()
            }
        }
    }

    private fun retry() {
        errorOverlay.hide()
        if (mainPageFailed || webView.url.isNullOrBlank() || webView.url?.startsWith("chrome-error:") == true) {
            loadDouyin()
        } else {
            webView.reload()
        }
    }

    private var lastNativeExitPromptMs = 0L

    private fun handleBack() {
        if (fullscreenContainer.isFullscreen()) {
            fullscreenContainer.hideFullscreen()
            return
        }
        // 交由红果状态机处理：关闭快捷菜单 / 退出原生模式 / 视频页双击提示再次双击退出抖音
        val js = "window.HongguoTV && window.HongguoTV.glassesGesture ? window.HongguoTV.glassesGesture('doubleClick') : 'no-bridge'"
        webView.evaluateJavascript(js) { raw ->
            when (raw?.trim()?.removeSurrounding("\"")) {
                "menu-close" -> showHud(getString(R.string.hud_menu_close))
                "login-mode" -> showHud(getString(R.string.hud_login_mode))
                "qr-zoom-out" -> showHud(getString(R.string.hud_qr_zoom_out))
                "back-player" -> showHud(getString(R.string.hud_back))
                "exit-confirm" -> showHud(getString(R.string.hud_exit_confirm))
                "exit-app" -> finish()
                else -> {
                    val now = System.currentTimeMillis()
                    if (now - lastNativeExitPromptMs <= 2500L) {
                        finish()
                    } else {
                        lastNativeExitPromptMs = now
                        showHud(getString(R.string.hud_exit_confirm))
                    }
                }
            }
        }
    }

    private fun loadDouyin() {
        val incoming = intent?.data?.toString()
        val url = if (!incoming.isNullOrBlank()) incoming else DOUYIN_URL
        webView.loadUrl(url)
    }

    private fun lastVideoId(): String? =
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString(KEY_LAST_VIDEO, null)
            ?.takeIf { it.matches(Regex("\\d{6,32}")) }

    /**
     * JS ↔ 原生持久化桥：
     * - saveVideo: 保存当前播放 aweme_id
     * - saveStateJson / loadStateJson: 持久化观看历史、收藏列表与播放进度
     */
    private inner class NativeBridge {
        @JavascriptInterface
        fun saveVideo(id: String) {
            if (id.matches(Regex("\\d{6,32}"))) {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_LAST_VIDEO, id)
                    .apply()
            }
        }

        @JavascriptInterface
        fun saveStateJson(json: String) {
            if (json.length <= 512_000) {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_HONGGUO_STATE, json)
                    .apply()
            }
        }

        @JavascriptInterface
        fun loadStateJson(): String {
            return getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_HONGGUO_STATE, "") ?: ""
        }

        @JavascriptInterface
        fun getVolumePercent(): Int {
            return getStreamVolumePercent()
        }

        @JavascriptInterface
        fun adjustVolume(delta: Int): Int {
            return adjustStreamVolumeByDelta(delta)
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finish() }
        }

        /** 云台防抖开关（快捷菜单入口）：主线程同步切换并持久化，返回切换后的实际状态。 */
        @JavascriptInterface
        fun setGimbalStabilizer(on: Boolean): Boolean {
            val latch = CountDownLatch(1)
            var result = false
            runOnUiThread {
                result = stabilizer.setEnabled(on)
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_GIMBAL_STAB, result)
                    .apply()
                latch.countDown()
            }
            try {
                latch.await(2, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            return result
        }

        @JavascriptInterface
        fun isGimbalStabilizerOn(): Boolean = stabilizer.enabled

        @JavascriptInterface
        fun getGimbalMode(): String = stabilizer.mode.id

        /** Stable IDs: legacy_follow / follow / anchored. Mode changes establish a new center. */
        @JavascriptInterface
        fun setGimbalMode(id: String) {
            val mode = StabilizerMode.fromId(id) ?: return
            stabilizer.setMode(mode)
            runOnUiThread {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(KEY_GIMBAL_MODE, mode.id).apply()
            }
        }

        @JavascriptInterface
        fun recenterGimbal() { runOnUiThread { stabilizer.recenter() } }

        @JavascriptInterface
        fun notifyGimbalVideoFrame() { stabilizer.onVideoFrame() }

        @JavascriptInterface
        fun isGimbalQualityEnhanced(): Boolean = stabilizer.qualityEnhanced

        @JavascriptInterface
        fun setGimbalQualityEnhanced(on: Boolean): Boolean {
            stabilizer.setQualityEnhanced(on)
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_GIMBAL_QUALITY, on).apply()
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.HongguoTV && window.HongguoTV.onQualityChanged && window.HongguoTV.onQualityChanged($on)", null)
            }
            return on
        }

        /** 播放状态闸门：JS 引擎在播放/暂停/切视图时驱动，仅播放中跑防抖管线（省电）。 */
        @JavascriptInterface
        fun setGimbalActive(active: Boolean) {
            runOnUiThread {
                if (::stabilizer.isInitialized) stabilizer.setActive(active)
            }
        }
    }

    private fun setupBackPressHandler() {
        onBackPressedDispatcher.addCallback(this) {
            handleBack()
        }
    }

    // ---- 眼镜 KeyEvent 路径（广播路径见 GlassesInputManager）----

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (glassesInput.onRingKeyEvent(event)) return true
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 &&
            glassesInput.onKeyEventDown(event.keyCode, event.eventTime)
        ) {
            return true
        }
        if (event.action == KeyEvent.ACTION_UP &&
            glassesInput.onKeyEventUp(event.keyCode, event.repeatCount)
        ) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            glassesInput.onBackKey(event?.repeatCount ?: 0)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (event != null && glassesInput.onKeyEventUp(keyCode, event.repeatCount)) {
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    // ---- HUD ----

    private fun showHud(text: String) {
        hud.text = text
        hud.visibility = View.VISIBLE
        hudHideRunnable?.let { hudHandler.removeCallbacks(it) }
        val r = Runnable { hud.visibility = View.GONE }
        hudHideRunnable = r
        hudHandler.postDelayed(r, HUD_TIMEOUT_MS)
    }

    // ---- 红果同源桥 + 播控引擎注入 ----

    private fun injectGlassesKit(view: WebView?) {
        view?.evaluateJavascript(hongguoBootstrapScript, null)
    }

    private fun buildHongguoBootstrapScript(): String {
        val css = assets.open("hongguo/douyin_hongguo.css").bufferedReader().use { it.readText() }
        val js = assets.open("hongguo/douyin_hongguo.js").bufferedReader().use { it.readText() }
        val quotedCss = JSONObject.quote(css)
        return "window.__HG_DOUYIN_CSS__ = $quotedCss;\n$js"
    }

    private fun setupImmersiveWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
        if (::stabilizer.isInitialized) stabilizer.resume()
    }

    override fun onPause() {
        if (::stabilizer.isInitialized) stabilizer.pause()
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        hudHandler.removeCallbacksAndMessages(null)
        if (::glassesInput.isInitialized) {
            glassesInput.unregister()
        }
        if (::stabilizer.isInitialized) {
            stabilizer.destroy()
        }
        networkMonitor.unregister()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "DouyinMini"
        private const val DOUYIN_URL = "https://www.douyin.com"
        private const val HUD_TIMEOUT_MS = 1000L
        private const val PREFS_NAME = "douyin_glasses"
        private const val KEY_LAST_VIDEO = "last_video"
        private const val KEY_HONGGUO_STATE = "hongguo_state_v1"
        private const val KEY_GIMBAL_STAB = "gimbal_stabilizer_on"
        private const val KEY_GIMBAL_MODE = "gimbal_mode"
        private const val KEY_GIMBAL_QUALITY = "gimbal_quality_enhanced"
    }
}
