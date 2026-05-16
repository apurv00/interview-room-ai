/**
 * Tiny pure helper extracted from MultimodalAnalysisTab so the scan can be
 * unit-tested in isolation. Returns the largest-indexed question marker
 * whose offsetSeconds <= currentTimeSec, or -1 if currentTimeSec is before
 * the first marker (e.g. intro / silence at the start of the recording).
 *
 * Initialized at -1 (no active question) per Codex P2 on PR #370 — the
 * previous initialization at 0 incorrectly highlighted Q1 during pre-Q1
 * playback. Downstream consumers must guard against `< 0` before indexing.
 */
interface QuestionMarker {
  offsetSeconds: number
}

export function findActiveQuestionIndex(
  questionMarkers: ReadonlyArray<QuestionMarker>,
  currentTimeSec: number
): number {
  if (!questionMarkers.length) return -1
  let last = -1
  for (let i = 0; i < questionMarkers.length; i++) {
    if (questionMarkers[i].offsetSeconds <= currentTimeSec) last = i
    else break
  }
  return last
}
