export type QuestionDisplay =
  | { kind: 'intro' }
  | { kind: 'question'; number: number; progressIndex?: number }
  | { kind: 'follow_up'; number: number; parentNumber?: number; progressIndex?: number }
  | { kind: 'wrap_up' }

export const INITIAL_QUESTION_DISPLAY: QuestionDisplay = { kind: 'intro' }

export function questionDisplayLabel(display: QuestionDisplay): string {
  switch (display.kind) {
    case 'intro':
      return 'Introduction'
    case 'question':
      return `Question ${display.number}`
    case 'follow_up':
      return `Follow-up ${display.number}`
    case 'wrap_up':
      return 'Wrap-up'
  }
}

export function questionDisplayProgressIndex(display: QuestionDisplay): number | null {
  if (display.kind === 'question') return display.progressIndex ?? display.number
  if (display.kind === 'follow_up') return display.progressIndex ?? display.parentNumber ?? null
  return null
}

export function clampProgressIndex(index: number | null, total: number): number | null {
  if (index == null || total <= 0) return null
  return Math.max(1, Math.min(total, Math.round(index)))
}
