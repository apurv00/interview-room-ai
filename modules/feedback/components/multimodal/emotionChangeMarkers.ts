import type { FacialSegment } from '@shared/types/multimodal'

export interface EmotionMarker {
  /** Seconds from session start where the non-neutral expression begins. */
  sec: number
  /** The expression class that starts here (never 'neutral'). */
  expression: string
}

interface QuestionMarker {
  offsetSeconds: number
}

/**
 * Sparse emotion-CHANGE markers for the replay timeline.
 *
 * Replaces the old ExpressionStrip, which rendered one emoji under EVERY
 * question — a wall of mostly-😐 that cluttered the timeline and got worse the
 * more questions an interview had. Emotion is only *information* at a transition,
 * so this emits a marker ONLY when the per-question dominant expression changes
 * INTO a non-neutral class (neutral is the baseline and never gets a marker).
 *
 * Rules:
 *  - `facialByQ[i]` aligns with `questions[i]` (both in interview/time order).
 *  - Consecutive questions with the same expression collapse to one marker at
 *    the first (the change point).
 *  - A change back to neutral updates the running state but emits no marker.
 *  - Windows with no facial data (`dominantExpression` undefined) are skipped
 *    and do NOT reset the running state (a data gap isn't an emotion change).
 *
 * Sparse by construction (far fewer than one-per-question), so collisions are
 * rare even in long interviews — though two changes at nearby question
 * timestamps can still land close together.
 */
export function computeEmotionChangeMarkers(
  facialByQ: ReadonlyArray<FacialSegment | undefined>,
  questions: ReadonlyArray<QuestionMarker>,
): EmotionMarker[] {
  const markers: EmotionMarker[] = []
  let prev: string | undefined
  for (let i = 0; i < questions.length; i++) {
    const expr = facialByQ[i]?.dominantExpression
    if (!expr) continue
    if (expr === prev) continue
    if (expr !== 'neutral') {
      markers.push({ sec: questions[i].offsetSeconds, expression: expr })
    }
    prev = expr
  }
  return markers
}
