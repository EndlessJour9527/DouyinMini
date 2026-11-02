package com.douyinmini.stabilizer

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI

class PosePredictionTest {
    private fun yaw(degrees: Double) = Q.axisAngle(0.0, 1.0, 0.0, degrees * PI / 180)

    @Test fun sensorClockConversionDoesNotTreatDeepSleepAsPredictionTime() {
        val elapsed = 5_000_000_000_000L
        assertEquals(990_000_000L, sensorTimeToUptime(elapsed - 10_000_000, elapsed, 1_000_000_000))
        assertNull(sensorTimeToUptime(elapsed - 100_000_000, elapsed, 1_000_000_000))
        assertNull(sensorTimeToUptime(elapsed + 1, elapsed, 1_000_000_000))
    }

    @Test fun predictsConstantVelocityToPresentationTime() {
        val predictor = PosePredictor()
        predictor.update(yaw(0.0), yaw(0.0), 1_000_000_000, 0.0)
        val sample = predictor.update(yaw(1.0), yaw(1.0), 1_010_000_000, 100.0)!!
        assertEquals(0.0, sample.predict(1_020_000_000).angularDistance(yaw(2.0)), 0.001)
    }

    @Test fun staleSamplesDoNotKeepRotatingOrPredictBeyondThreeDegrees() {
        val predictor = PosePredictor()
        predictor.update(yaw(0.0), yaw(0.0), 1_000_000_000, 0.0)
        val sample = predictor.update(yaw(10.0), yaw(10.0), 1_010_000_000, 1000.0)!!
        assertTrue(sample.orientation.angularDistance(sample.predict(1_040_000_000)) <= 3.001)
        assertEquals(0.0, sample.orientation.angularDistance(sample.predict(1_100_000_000)), 0.001)
        assertNull(predictor.update(yaw(2.0), yaw(2.0), 1_009_000_000, 1.0))
    }

    @Test fun quaternionSignFlipDoesNotPredictAFullTurn() {
        val predictor = PosePredictor()
        predictor.update(yaw(1.0), yaw(1.0), 1_000_000_000, 0.0)
        val sample = predictor.update(yaw(1.0) * -1.0, yaw(1.0), 1_010_000_000, 0.0)!!
        assertEquals(0.0, sample.predict(1_025_000_000).angularDistance(yaw(1.0)), 0.001)
    }
}
