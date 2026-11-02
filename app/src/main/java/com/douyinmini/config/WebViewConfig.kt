package com.douyinmini.config

import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

object WebViewConfig {

    fun configure(webView: WebView) {
        WebView.setWebContentsDebuggingEnabled(true)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.apply {
            // Let WebView manage its video compositor instead of caching the whole view in a hardware layer.
            setLayerType(View.LAYER_TYPE_NONE, null)
            overScrollMode = WebView.OVER_SCROLL_NEVER

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                setSupportZoom(false)
                loadsImagesAutomatically = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                allowFileAccess = false
                allowContentAccess = false
                setSupportMultipleWindows(false)
                userAgentString = buildUserAgent()
                // 关闭宽视口/overview：页面写死 min-width 时 WebView 会把布局撑到 640 再缩 0.75，
                // 强制布局宽度 = 屏幕物理宽（480），配合注入 JS 清除容器 min-width
                useWideViewPort = false
                loadWithOverviewMode = false
            }
        }
    }

    private fun buildUserAgent(): String {
        // 移动端 UA：抖音按手机宽度排版，480px 眼镜屏正好铺满（桌面布局在该密度下无法阅读）
        return "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    }
}
