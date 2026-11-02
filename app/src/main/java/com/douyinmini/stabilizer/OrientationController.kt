package com.douyinmini.stabilizer

import kotlin.math.exp
import kotlin.math.max

/** Stable IDs shared with the Javascript bridge and persisted preferences. */
enum class StabilizerMode(val id: String) {
    LEGACY_FOLLOW("legacy_follow"), FOLLOW("follow"), ANCHORED("anchored");

    companion object {
        fun fromId(id: String): StabilizerMode? = entries.firstOrNull { it.id == id }
    }
}

/** GL-thread-only orientation anchor. Independent of content/video frame rate. */
internal class OrientationController {
    private var anchor: Q? = null
    private var previousTime = 0L
    private var previousMode = StabilizerMode.FOLLOW
    private var previousRecenter = 0

    fun update(
        head: Q, followTarget: Q, speedDeg: Double, timeNanos: Long,
        mode: StabilizerMode, recenter: Int,
    ): Q {
        if (anchor == null || mode != previousMode || recenter != previousRecenter) {
            anchor = head
            previousTime = timeNanos
            previousMode = mode
            previousRecenter = recenter
            return Q.IDENTITY
        }
        val dt = ((timeNanos - previousTime) / 1e9).coerceIn(0.0, 0.05)
        previousTime = timeNanos
        var reference = anchor!!
        if (mode == StabilizerMode.LEGACY_FOLLOW) {
            val gate = 1.0 / (1.0 + (speedDeg / 25.0) * (speedDeg / 25.0))
            reference = reference.slerp(followTarget, (1.0 - exp(-dt / 0.35)) * gate)
            anchor = reference
        } else if (mode == StabilizerMode.FOLLOW) {
            val error = reference.angularDistance(followTarget)
            val gate = 1.0 / (1.0 + (speedDeg / 25.0) * (speedDeg / 25.0))
            // Preserve shake rejection near center, but don't freeze the window on intentional turns.
            val catchUp = ((error - 1.5) / 1.5).coerceIn(0.0, 1.0)
            val alpha = (1.0 - exp(-dt / 0.25)) * max(gate, catchUp)
            reference = reference.slerp(followTarget, alpha)
            val offset = reference.angularDistance(head)
            if (offset > 3.0) reference = head.slerp(reference, 3.0 / offset)
            anchor = reference
        }
        return reference.inverse() * head
    }
}
