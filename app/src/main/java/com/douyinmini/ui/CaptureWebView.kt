package com.douyinmini.ui

import android.content.Context
import android.graphics.Canvas
import android.util.AttributeSet
import android.webkit.WebView

/** Keep Chromium attached/visible, but avoid drawing it into both the window and capture surface. */
class CaptureWebView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = android.R.attr.webViewStyle,
) : WebView(context, attrs, defStyleAttr) {
    var captureOnly = false
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    override fun draw(canvas: Canvas) {
        if (!captureOnly) super.draw(canvas)
    }

    /** Only the stabilizer records content; ordinary window traversal skips its duplicate draw. */
    fun drawForCapture(canvas: Canvas) { super.draw(canvas) }
}
