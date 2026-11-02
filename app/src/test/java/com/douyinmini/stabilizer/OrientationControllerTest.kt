package com.douyinmini.stabilizer

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI

class OrientationControllerTest {
    private fun yaw(degrees: Double) = Q.axisAngle(0.0, 1.0, 0.0, degrees * PI / 180)

    @Test fun originalFollowRetainsIts350msSpeedGateWithoutTheNewOffsetLimit() {
        val controller = OrientationController()
        controller.update(Q.IDENTITY, Q.IDENTITY, 0.0, 1_000_000_000, StabilizerMode.LEGACY_FOLLOW, 0)
        val result = controller.update(yaw(20.0), yaw(20.0), 100.0,
            1_016_666_667, StabilizerMode.LEGACY_FOLLOW, 0)
        val alpha = (1.0 - kotlin.math.exp(-0.016666667 / 0.35)) / 17.0
        assertEquals(20.0 * (1.0 - alpha), result.angularDistance(Q.IDENTITY), 0.001)
        assertTrue(result.angularDistance(Q.IDENTITY) > 3.0)
    }

    @Test fun followBoundsFastTurnsAndSettlesBackToCenter() {
        val controller = OrientationController()
        controller.update(Q.IDENTITY, Q.IDENTITY, 0.0, 1_000_000_000, StabilizerMode.FOLLOW, 0)
        var result = Q.IDENTITY
        for (i in 1..60) {
            result = controller.update(yaw(i.toDouble()), yaw(i.toDouble()), 60.0,
                1_000_000_000 + i * 16_666_667L, StabilizerMode.FOLLOW, 0)
            assertTrue(result.angularDistance(Q.IDENTITY) <= 3.001)
        }
        for (i in 61..240) result = controller.update(yaw(60.0), yaw(60.0), 0.0,
            1_000_000_000 + i * 16_666_667L, StabilizerMode.FOLLOW, 0)
        assertTrue(result.angularDistance(Q.IDENTITY) < 0.01)
    }

    @Test fun anchoredModeNeverFollowsEvenAfterSeveralSeconds() {
        val controller = OrientationController()
        controller.update(yaw(10.0), yaw(10.0), 0.0, 1_000_000_000, StabilizerMode.ANCHORED, 0)
        var result = Q.IDENTITY
        for (i in 1..180) result = controller.update(yaw(40.0), yaw(40.0), 0.0,
            1_000_000_000 + i * 16_666_667L, StabilizerMode.ANCHORED, 0)
        assertEquals(0.0, result.angularDistance(yaw(30.0)), 0.001)
    }

    @Test fun switchingModeAndRecenteringDoNotJumpToAnOldAnchor() {
        val controller = OrientationController()
        controller.update(yaw(10.0), yaw(10.0), 0.0, 1_000_000_000, StabilizerMode.FOLLOW, 0)
        val switched = controller.update(yaw(30.0), yaw(30.0), 0.0, 1_016_000_000, StabilizerMode.ANCHORED, 0)
        assertEquals(0.0, switched.angularDistance(Q.IDENTITY), 0.001)
        val recentered = controller.update(yaw(60.0), yaw(60.0), 0.0, 1_032_000_000, StabilizerMode.ANCHORED, 1)
        assertEquals(0.0, recentered.angularDistance(Q.IDENTITY), 0.001)
    }
}
