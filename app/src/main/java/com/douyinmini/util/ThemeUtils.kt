package com.douyinmini.util

import android.os.Build
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat

object ThemeUtils {

    /** 眼镜屏为纯黑背景，WebView 内容强制深色渲染。 */
    @Suppress("DEPRECATION")
    fun forceDark(webView: WebView) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WebSettingsCompat.setForceDark(
                webView.settings,
                WebSettingsCompat.FORCE_DARK_ON
            )
        }
    }
}
