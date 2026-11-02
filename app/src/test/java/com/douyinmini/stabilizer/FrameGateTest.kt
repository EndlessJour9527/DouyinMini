package com.douyinmini.stabilizer

import org.junit.Assert.*
import org.junit.Test

class FrameGateTest {
    @Test fun coalescesCapturesUntilTheConsumerLatchesTheFrame() {
        val gate = FrameGate()
        assertTrue(gate.tryAcquire(1_000_000_000))
        assertFalse(gate.tryAcquire(1_016_666_666))
        gate.onConsumed()
        assertTrue(gate.tryAcquire(1_033_333_333))
    }

    @Test fun recoversWhenHardwareRendererDropsAFrameWithoutACallback() {
        val gate = FrameGate()
        assertTrue(gate.tryAcquire(1_000_000_000))
        assertFalse(gate.tryAcquire(1_099_999_999))
        assertTrue(gate.tryAcquire(1_100_000_000))
    }

    @Test fun videoFramesDoNotRequireRecapturingTheWebViewAtDisplayRate() {
        val gate = FrameGate()
        gate.onVideoFrame()
        assertTrue(gate.tryAcquire(1_000_000_000))
        gate.onConsumed()
        assertFalse(gate.tryAcquire(1_016_666_667))
        gate.onVideoFrame()
        assertTrue(gate.tryAcquire(1_033_333_333))
    }

    @Test fun uiChangesAndFallbackStillRefreshWhenTheVideoIsNotAdvancing() {
        val gate = FrameGate()
        gate.onVideoFrame()
        assertTrue(gate.tryAcquire(1_000_000_000))
        gate.onConsumed()
        assertTrue(gate.tryAcquire(1_100_000_000))
        gate.onConsumed()
        gate.onUiChanged(1_100_000_000)
        assertTrue(gate.tryAcquire(1_116_666_667))
    }
}
