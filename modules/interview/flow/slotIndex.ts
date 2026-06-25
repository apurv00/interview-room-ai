/**
 * Flow slot index for the NEXT question = number of completed FLOW threads.
 *
 * The intro ("tell me about yourself") is a completed thread but NOT a flow slot, so for
 * the academics viva — which depends on a strict favourite → fundamentals → derive
 * sequence — it must be excluded, or the fundamentals slot is skipped (the intro inflates
 * `completedThreads.length` by one). Other depths keep the legacy 1:1 indexing, so their
 * established question selection is unchanged.
 */
export function flowSlotIndex(interviewType: string, completedThreadCount: number): number {
  if (interviewType === 'academics' && completedThreadCount > 0) return completedThreadCount - 1
  return completedThreadCount
}
