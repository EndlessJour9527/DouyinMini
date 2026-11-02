package com.douyinmini.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import androidx.core.content.ContextCompat

/**
 * 眼镜输入统一分发：镜腿/TouchPad 有序广播 + TouchPad KeyEvent + 单指滑动序列。
 *
 * 事件定义见 docs/glasses-integration.md。
 *
 * 语义映射（去抖 [DEBOUNCE_MS]，因单指长按存在 `KEYCODE_PROG_BLUE` 与广播 `ACTION_AI_START` 两路并存）：
 * - 单指单击 → [Listener.onTouchpadClick]（`KEYCODE_ENTER`，由宿主在 onKeyUp 转发）
 * - 单指双击 → [Listener.onTouchpadDoubleClick]（`KEYCODE_BACK`，兼作系统返回）
 * - 单指长按 → [Listener.onTouchpadLongPress]（KeyEvent + 广播两路）
 * - 单指前滑/后滑 → [Listener.onSwipeForward] / [Listener.onSwipeBack]（DPAD 两键序列，≤500ms）
 * - 镜腿单击 → [Listener.onTempleClick]
 * - 摘下眼镜 / 折叠镜腿 → [Listener.onGlassesRemoved]
 *
 * 其余事件（镜腿长按/双击、双指手势等）仅在有序广播中 abort，避免触发系统 AI / 设置 / 关机。
 * 双指滑动原先映射「手动缩放」，已随移动端布局（无需缩放）移除，现仅 abort。
 */
class GlassesInputManager(context: Context) {

    interface Listener {
        /** 触摸板单指单击：执行焦点控件或播放/暂停；错误页时为重试。 */
        fun onTouchpadClick()

        /** 触摸板单指双击（KEYCODE_BACK）：关闭菜单/返回上一层级。 */
        fun onTouchpadDoubleClick()

        /** 触摸板单指长按：打开/关闭红果式快捷菜单。 */
        fun onTouchpadLongPress()

        /** 单指前滑：沉浸态下一条视频 / 菜单态下一焦点。 */
        fun onSwipeForward()

        /** 单指后滑：沉浸态上一条视频 / 菜单态上一焦点。 */
        fun onSwipeBack()

        /** 双指双击：快捷收藏/取消收藏当前视频。 */
        fun onTwoFingerDoubleTap() {}

        /** 镜腿功能键单击：静音切换。 */
        fun onTempleClick()

        /** 摘下眼镜或折叠镜腿：自动暂停。 */
        fun onGlassesRemoved()

        /** 戴上眼镜：恢复状态提示。 */
        fun onGlassesPutOn() {}
    }

    private val appContext = context.applicationContext

    private val lastFire = mutableMapOf<String, Long>()

    private val swipeDetector = SwipeDetector(
        onSwipeForward = { fire("swipe_forward") { it.onSwipeForward() } },
        onSwipeBack = { fire("swipe_back") { it.onSwipeBack() } },
    )

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                Action.TEMPLE_CLICK -> {
                    abortOrdered(this)
                    fire("temple_click") { it.onTempleClick() }
                }
                Action.AI_START -> {
                    abortOrdered(this)
                    fire("long_press") { it.onTouchpadLongPress() }
                }
                Action.TWO_FINGER_DOUBLE_TAP -> {
                    abortOrdered(this)
                    fire("two_finger_double_tap") { it.onTwoFingerDoubleTap() }
                }
                Action.TWO_FINGER_SWIPE_FORWARD,
                Action.TWO_FINGER_SWIPE_BACK,
                Action.TEMPLE_LONG_PRESS,
                Action.TEMPLE_DOUBLE_CLICK,
                Action.SETTINGS_KEY -> abortOrdered(this)
                Action.TAKE_STATUS -> {
                    val state = intent.getStringExtra(Extra.TAKE_STATE)
                    if (state == STATE_OFF) {
                        fire("glasses_off") { it.onGlassesRemoved() }
                    } else if (state == STATE_ON) {
                        fire("glasses_on") { it.onGlassesPutOn() }
                    }
                }
                Action.LEG_STATUS -> {
                    if (intent.getStringExtra(Extra.LEG_STATE) == STATE_OFF) {
                        fire("glasses_off") { it.onGlassesRemoved() }
                    }
                }
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            priority = IntentFilter.SYSTEM_HIGH_PRIORITY
            listOf(
                Action.TEMPLE_CLICK,
                Action.TEMPLE_DOUBLE_CLICK,
                Action.TEMPLE_LONG_PRESS,
                Action.AI_START,
                Action.TWO_FINGER_DOUBLE_TAP,
                Action.TWO_FINGER_SWIPE_FORWARD,
                Action.TWO_FINGER_SWIPE_BACK,
                Action.SETTINGS_KEY,
                Action.TAKE_STATUS,
                Action.LEG_STATUS,
            ).forEach { addAction(it) }
        }
        ContextCompat.registerReceiver(appContext, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    var listener: Listener? = null

    /** R10223 戒指发送 F1 + 单个方向键；不能交给触摸板的双键序列检测。 */
    fun onRingKeyEvent(event: KeyEvent): Boolean {
        val device = event.device ?: return false
        val isRing = (device.vendorId == 0x3a39 && device.productId == 0x5231) ||
            device.name.startsWith("R10223")
        if (!isRing) return false
        Log.d(TAG, "戒指输入 device=${device.name} key=${event.keyCode} scan=${event.scanCode} action=${event.action} repeat=${event.repeatCount}")
        if (event.keyCode !in setOf(KeyEvent.KEYCODE_F1, KeyEvent.KEYCODE_NOTIFICATION, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)) {
            return false
        }
        // 按住产生的重复 DOWN 和 UP 都消费，每次按下只翻一条。
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> fire("swipe_back") { it.onSwipeBack() }
                KeyEvent.KEYCODE_DPAD_RIGHT -> fire("swipe_forward") { it.onSwipeForward() }
            }
        }
        return true
    }

    /** dispatchKeyEvent 中 ACTION_DOWN（repeatCount==0）转发；返回 true 表示已消费。 */
    fun onKeyEventDown(keyCode: Int, eventTime: Long): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> return true
            KeyEvent.KEYCODE_PROG_BLUE -> {
                fire("long_press") { it.onTouchpadLongPress() }
                return true
            }
            // 双指单击（keyCode 83）与双指长按：仅消费，无 UI 动作
            KeyEvent.KEYCODE_NOTIFICATION, KeyEvent.KEYCODE_SETTINGS -> return true
            else -> return swipeDetector.onKeyDown(keyCode, eventTime)
        }
    }

    /** onKeyUp 转发；返回 true 表示已消费。 */
    fun onKeyEventUp(keyCode: Int, repeatCount: Int): Boolean {
        if (keyCode == KeyEvent.KEYCODE_ENTER && repeatCount == 0) {
            fire("click") { it.onTouchpadClick() }
            return true
        }
        return false
    }

    /** KEYCODE_BACK：触摸板双击 = 返回；返回 true 表示已消费。 */
    fun onBackKey(repeatCount: Int): Boolean {
        if (repeatCount == 0) {
            fire("double_click") { it.onTouchpadDoubleClick() }
        }
        return true
    }

    fun unregister() {
        try {
            appContext.unregisterReceiver(receiver)
        } catch (_: Exception) {
        }
        listener = null
    }

    /** 同语义事件 [DEBOUNCE_MS] 内只触发一次（广播与 KeyEvent 两路并存时去重）。 */
    private fun fire(key: String, invoke: (Listener) -> Unit) {
        val now = SystemClock.elapsedRealtime()
        if (now - (lastFire[key] ?: 0L) < DEBOUNCE_MS) {
            Log.d(TAG, "手势 $key 去抖跳过")
            return
        }
        lastFire[key] = now
        Log.d(TAG, "手势: $key")
        listener?.let(invoke)
    }

    private fun abortOrdered(receiver: BroadcastReceiver): Boolean {
        if (!receiver.isOrderedBroadcast) {
            Log.w(TAG, "abort skipped: not ordered broadcast")
            return false
        }
        return try {
            receiver.abortBroadcast()
            true
        } catch (e: IllegalStateException) {
            Log.w(TAG, "abortBroadcast failed: ${e.message}")
            false
        }
    }

    /**
     * 单指前滑/后滑检测：连续两个 ACTION_DOWN 按键序列，间隔 ≤ [SwipeDetector.MAX_INTERVAL_MS]。
     * 序列首键一并消费，避免泄漏给焦点导航。
     */
    private class SwipeDetector(
        private val onSwipeForward: () -> Unit,
        private val onSwipeBack: () -> Unit,
    ) {
        private var lastKeyCode = -1
        private var lastEventTime = 0L

        fun onKeyDown(keyCode: Int, eventTime: Long): Boolean {
            val prev = if (eventTime - lastEventTime <= MAX_INTERVAL_MS) lastKeyCode else -1
            lastKeyCode = keyCode
            lastEventTime = eventTime
            return when {
                prev == FORWARD_FIRST && keyCode == FORWARD_SECOND -> {
                    onSwipeForward()
                    reset()
                    true
                }
                prev == BACK_FIRST && keyCode == BACK_SECOND -> {
                    onSwipeBack()
                    reset()
                    true
                }
                keyCode == FORWARD_FIRST || keyCode == BACK_FIRST -> true
                else -> false
            }
        }

        fun reset() {
            lastKeyCode = -1
            lastEventTime = 0L
        }

        companion object {
            private const val FORWARD_FIRST = KeyEvent.KEYCODE_DPAD_RIGHT   // 22
            private const val FORWARD_SECOND = KeyEvent.KEYCODE_DPAD_DOWN   // 20
            private const val BACK_FIRST = KeyEvent.KEYCODE_DPAD_LEFT       // 21
            private const val BACK_SECOND = KeyEvent.KEYCODE_DPAD_UP        // 19
            private const val MAX_INTERVAL_MS = 500L
        }
    }

    object Action {
        const val TEMPLE_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_CLICK"
        const val TEMPLE_DOUBLE_CLICK = "com.android.action.ACTION_SPRITE_BUTTON_DOUBLE_CLICK"
        const val TEMPLE_LONG_PRESS = "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS"
        const val AI_START = "com.android.action.ACTION_AI_START"
        const val TWO_FINGER_DOUBLE_TAP = "com.android.action.ACTION_TWO_FINGER_DOUBLE_TAP"
        const val TWO_FINGER_SWIPE_FORWARD = "com.android.action.ACTION_TWO_FINGER_SWIPE_FORWARD"
        const val TWO_FINGER_SWIPE_BACK = "com.android.action.ACTION_TWO_FINGER_SWIPE_BACK"
        const val SETTINGS_KEY = "com.android.action.ACTION_SETTINGS_KEY"
        const val TAKE_STATUS = "com.rokid.sprite.ACTION_TAKE_STATUS_CHANGED"
        const val LEG_STATUS = "com.rokid.sprite.ACTION_LEG_STATUS_CHANGED"
    }

    object Extra {
        const val TAKE_STATE = "glasses_take_state"
        const val LEG_STATE = "glasses_leg_state"
    }

    companion object {
        private const val TAG = "GlassesInput"
        private const val STATE_OFF = "0"
        private const val STATE_ON = "1"
        private const val DEBOUNCE_MS = 350L
    }
}
