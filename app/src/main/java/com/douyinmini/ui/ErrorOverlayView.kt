package com.douyinmini.ui

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import com.douyinmini.R

class ErrorOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : LinearLayout(context, attrs, defStyleAttr) {

    private var retryCallback: (() -> Unit)? = null

    val isVisible: Boolean
        get() = visibility == View.VISIBLE

    init {
        View.inflate(context, R.layout.view_error_overlay, this)
    }

    fun setOnRetryListener(callback: () -> Unit) {
        retryCallback = callback
        val trigger = View.OnClickListener {
            hide()
            retryCallback?.invoke()
        }
        findViewById<Button>(R.id.btn_retry).setOnClickListener(trigger)
        // 眼镜交互：触摸板单击经 onConfirmAction 重试；此处支持点击任意处重试
        setOnClickListener(trigger)
    }

    fun show() {
        visibility = View.VISIBLE
    }

    fun hide() {
        visibility = View.GONE
    }
}
