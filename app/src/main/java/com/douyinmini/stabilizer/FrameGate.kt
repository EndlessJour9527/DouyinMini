package com.douyinmini.stabilizer

/** Coalesce input while the GL thread independently warps the last texture at display cadence. */
internal class FrameGate {
    private var pending = false
    private var submittedAt = 0L
    private var videoDriven = false
    private var contentVersion = 0L
    private var capturedVersion = -1L
    private var animateUntil = 0L

    @Synchronized fun onVideoFrame() {
        videoDriven = true
        contentVersion++
    }

    @Synchronized fun onUiChanged(nowNanos: Long) {
        contentVersion++
        animateUntil = nowNanos + 300_000_000L
    }

    @Synchronized fun tryAcquire(nowNanos: Long): Boolean {
        val sinceLastCapture = nowNanos - submittedAt
        // A dropped HWUI frame may never notify its consumer. Retry after 100ms.
        if (pending && sinceLastCapture < 100_000_000L) return false
        if (videoDriven && !pending && contentVersion == capturedVersion &&
            nowNanos >= animateUntil && sinceLastCapture < 100_000_000L) return false
        pending = true
        submittedAt = nowNanos
        capturedVersion = contentVersion
        return true
    }

    @Synchronized fun onConsumed() { pending = false }
}
