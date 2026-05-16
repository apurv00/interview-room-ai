/**
 * Composure — composite per-question "how steady was the candidate" score.
 *
 * Round 5b feature #8. Single verdict that collapses three multimodal signals
 * the user otherwise has to read separately:
 *
 *   audio    confidenceMarker ∈ {high, medium, low}  → 1.0 / 0.5 / 0.0
 *   facial   avgEyeContact    ∈ [0, 1]
 *   facial   headStability    ∈ [0, 1]
 *
 * The display is a 3-dot indicator (●●●, ●●○, ●○○) rather than a 0-100
 * number. Two design reasons:
 *
 *   1. Hick's Law — a discrete 3-step scale is faster to read than a
 *      continuous number for "at-a-glance" annotation on a chip.
 *   2. False precision avoidance — the composite is an honest average of
 *      three signals of varying reliability; presenting it as "67/100"
 *      implies a calibration we don't have.
 *
 * Fallback when facial data is missing (privacy mode, camera off): we map
 * the audio signal directly to dots (high → 3, medium → 2, low → 1) rather
 * than fabricating a facial score. When audio is also missing, return null
 * and the renderer hides the dots entirely. Honest-data rule: never
 * fabricate dots from no signal.
 */

import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

export type ComposureLevel = 1 | 2 | 3 | null

/** -1 is the facial-aggregator sentinel for "window had no usable frames". */
const FACIAL_SENTINEL = -1

function audioFraction(marker: ProsodySegment['confidenceMarker'] | undefined): number | null {
  if (marker === 'high') return 1
  if (marker === 'medium') return 0.5
  if (marker === 'low') return 0
  return null
}

function facialFraction(seg: FacialSegment | undefined): number | null {
  if (!seg) return null
  const eye = seg.avgEyeContact
  const stab = seg.headStability
  // Both sentinel/missing → no facial signal.
  if (
    (eye === FACIAL_SENTINEL || eye == null || !Number.isFinite(eye)) &&
    (stab === FACIAL_SENTINEL || stab == null || !Number.isFinite(stab))
  ) {
    return null
  }
  // At least one valid — average the valid ones, clamped to [0, 1].
  const parts: number[] = []
  if (Number.isFinite(eye) && eye !== FACIAL_SENTINEL) parts.push(Math.max(0, Math.min(1, eye)))
  if (Number.isFinite(stab) && stab !== FACIAL_SENTINEL) parts.push(Math.max(0, Math.min(1, stab)))
  if (parts.length === 0) return null
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

function levelFromFraction(f: number): ComposureLevel {
  if (f >= 0.67) return 3
  if (f >= 0.34) return 2
  return 1
}

/**
 * Composure level for one question.
 *
 *  - Both audio + facial present → average the two fractions, map to 1/2/3
 *  - Audio only                  → map confidenceMarker directly to dots
 *  - Facial only                 → map facial fraction directly to dots
 *  - Neither                     → null (renderer hides)
 */
export function composureLevel(
  prosody: ProsodySegment | undefined,
  facial: FacialSegment | undefined,
): ComposureLevel {
  const a = audioFraction(prosody?.confidenceMarker)
  const f = facialFraction(facial)

  if (a == null && f == null) return null
  if (a != null && f != null) return levelFromFraction((a + f) / 2)
  if (a != null) return levelFromFraction(a)
  if (f != null) return levelFromFraction(f)
  return null
}

/**
 * Composure for the full question array. Caller passes the per-question
 * prosody + facial arrays (whatever's available); we align by index.
 */
export function composureLevels(
  prosodyByQ: ProsodySegment[] | undefined,
  facialByQ: FacialSegment[] | undefined,
  questionCount: number,
): ComposureLevel[] {
  const out: ComposureLevel[] = []
  for (let i = 0; i < questionCount; i++) {
    out.push(composureLevel(prosodyByQ?.[i], facialByQ?.[i]))
  }
  return out
}
