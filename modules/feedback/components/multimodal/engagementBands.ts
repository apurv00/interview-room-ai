/**
 * Per-second engagement heatmap derivation.
 *
 * Round 5c feature #7. The facial aggregator already emits a per-second
 * timeseries (`analysis.facialTimeseries[]`) but no UI surface has ever
 * consumed it. Highest-resolution visibility into how the candidate's
 * attention shifted second-by-second across the entire interview.
 *
 * Two pieces of logic worth isolating from rendering:
 *
 *   1. `bandForEyeContact()` — categorical perception (Goldstone &
 *      Hendrickson) is faster than ordinal/continuous for at-a-glance
 *      reads. We map the [0, 1] avgEyeContact into 3 discrete bands +
 *      a sentinel state. Color the spans by band rather than by raw
 *      value so the user reads "good / okay / poor" instantly.
 *
 *   2. `downsampleHeatmap()` — for long sessions (>maxBuckets seconds),
 *      collapse adjacent seconds into bucket means. Keeps the DOM node
 *      count bounded AND keeps each rendered span ≥1 pixel wide so the
 *      color is actually perceivable. Without downsampling, a 30-minute
 *      session would render 1800 sub-pixel spans on a typical viewport
 *      — invisible and slow.
 */

import type { FacialSegment } from '@shared/types/multimodal'

/** -1 is the facialAggregator sentinel for "window had no usable frames". */
const FACIAL_SENTINEL = -1

export type EngagementBand = 'strong' | 'okay' | 'weak' | 'no-data'

/** Visual band thresholds. Tuned to match interview-coaching norms:
 *  - >=75% sustained eye contact reads as engaged ("strong")
 *  - 50–74% reads as variable ("okay" — looking but not steady)
 *  - <50% reads as disengaged ("weak" — looking away most of the time) */
const STRONG_THRESHOLD = 0.75
const OKAY_THRESHOLD = 0.5

/**
 * Map an avgEyeContact value (or sentinel) to a band. Out-of-range or
 * non-finite values fall back to `no-data` — honest data rule: never
 * fabricate a color for a signal we don't have.
 */
export function bandForEyeContact(avgEyeContact: number | null | undefined): EngagementBand {
  if (avgEyeContact == null) return 'no-data'
  if (!Number.isFinite(avgEyeContact)) return 'no-data'
  if (avgEyeContact === FACIAL_SENTINEL) return 'no-data'
  if (avgEyeContact < 0) return 'no-data' // defensive: clip ranges we shouldn't see
  if (avgEyeContact >= STRONG_THRESHOLD) return 'strong'
  if (avgEyeContact >= OKAY_THRESHOLD) return 'okay'
  return 'weak'
}

export interface HeatmapBucket {
  startSec: number
  endSec: number
  /** Mean of valid (non-sentinel, finite) eyeContact values in this bucket,
   *  or null when every input was a sentinel — passed to bandForEyeContact
   *  unchanged so null → 'no-data'. */
  avgEyeContact: number | null
  /** Count of input seconds with valid data (for hover diagnostics). */
  sampleCount: number
}

/**
 * Downsample a per-second timeseries into at most `maxBuckets` buckets
 * by adjacent-mean aggregation. Sentinel values (-1) are excluded from
 * the mean but don't disqualify the bucket — if 5 of 6 seconds in a
 * bucket are valid, the bucket's mean is computed from those 5. Only
 * when every input is a sentinel does the bucket inherit `no-data`.
 *
 * Returns the timeseries unchanged when it already fits in maxBuckets.
 * Default `maxBuckets = 600` chosen to:
 *   - keep DOM node count bounded (1 span per bucket)
 *   - keep each span >=1 pixel wide on a typical 720px-wide strip
 *
 * Pure, no React, easy to test.
 */
export function downsampleHeatmap(
  timeseries: ReadonlyArray<FacialSegment> | undefined,
  maxBuckets: number = 600,
): HeatmapBucket[] {
  if (!timeseries || timeseries.length === 0) return []
  if (maxBuckets <= 0) return []

  // Already small enough — pass through one bucket per segment.
  if (timeseries.length <= maxBuckets) {
    return timeseries.map((s) => {
      const v = s.avgEyeContact
      const valid = Number.isFinite(v) && v !== FACIAL_SENTINEL
      return {
        startSec: s.startSec,
        endSec: s.endSec,
        avgEyeContact: valid ? v : null,
        sampleCount: valid ? 1 : 0,
      }
    })
  }

  // Downsample. groupSize is the smallest integer such that
  // ceil(N / groupSize) <= maxBuckets.
  const groupSize = Math.ceil(timeseries.length / maxBuckets)
  const out: HeatmapBucket[] = []
  for (let i = 0; i < timeseries.length; i += groupSize) {
    const slice = timeseries.slice(i, i + groupSize)
    let sum = 0
    let valid = 0
    for (const s of slice) {
      const v = s.avgEyeContact
      if (Number.isFinite(v) && v !== FACIAL_SENTINEL) {
        sum += v
        valid++
      }
    }
    out.push({
      startSec: slice[0].startSec,
      endSec: slice[slice.length - 1].endSec,
      avgEyeContact: valid > 0 ? sum / valid : null,
      sampleCount: valid,
    })
  }
  return out
}
