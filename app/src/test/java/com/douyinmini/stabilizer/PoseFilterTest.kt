package com.douyinmini.stabilizer

import org.junit.Assert.*
import org.junit.Test

class PoseFilterTest {
    @Test fun resetClearsVelocityBeforeStartingANewSession() {
        val filter = PoseFilter()
        filter.read(Q.IDENTITY, 1_000_000_000)
        filter.read(Q.axisAngle(0.0, 1.0, 0.0, 0.1), 1_010_000_000)
        assertTrue(filter.speedDeg > 0)
        filter.reset()
        assertEquals(0.0, filter.speedDeg, 0.0)
    }

    @Test fun ignoresStaleSamplesAndTreatsQuaternionSignsAsTheSamePose() {
        val filter = PoseFilter()
        filter.read(Q.IDENTITY, 1_000_000_000)
        assertNull(filter.read(Q.IDENTITY, 999_999_999))
        val pose = filter.read(Q.IDENTITY * -1.0, 1_010_000_000)!!
        assertEquals(0.0, pose.angularDistance(Q.IDENTITY), 0.000001)
        assertEquals(0.0, filter.speedDeg, 0.000001)
    }
}
