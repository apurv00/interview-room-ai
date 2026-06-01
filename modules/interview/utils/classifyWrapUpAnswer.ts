export type WrapUpAnswerIntent = 'empty' | 'no_questions' | 'thank_you_only' | 'has_question'

export const WRAP_UP_REAL_QUESTION_SIGN_OFF =
  "Thank you for your time today - we'll be in touch with next steps."

export const WRAP_UP_NO_QUESTIONS_CLOSE =
  "No worries at all! Thank you so much for your time today - it was a pleasure speaking with you. We'll be in touch!"

export const WRAP_UP_THANK_YOU_CLOSE =
  "Thank you as well - I appreciate your time today. We'll be in touch with next steps."

const NO_QUESTION_PATTERNS = [
  /\b(?:i\s+)?(?:do\s+not|don't|dont)\s+have\s+(?:any\s+)?(?:questions?|queries?)\b/,
  /\b(?:i\s+)?(?:have|got)\s+no\s+(?:questions?|queries?)\b/,
  /\bno\s+(?:questions?|queries?)(?:\s+(?:from\s+me|from\s+my\s+side|right\s+now|at\s+the\s+moment|today))?\b/,
  /\bnothing\s+(?:from\s+me|from\s+my\s+side|else|right\s+now|at\s+the\s+moment)\b/,
  /\bnot\s+(?:right\s+now|at\s+the\s+moment)\b/,
]

const QUESTION_PHRASE_RE =
  /\b(?:what(?:'s| is| are| do| does)?|when|where|who|why|how(?:\s+long|\s+do|\s+does|\s+would|\s+will|\s+can)?|can\s+you|could\s+you|would\s+you|should\s+i|should\s+we|will\s+i|will\s+we|do\s+i|do\s+we|do\s+you|does\s+the|is\s+this|is\s+there|are\s+you|are\s+we|are\s+there|am\s+i|tell\s+me\s+about|next\s+steps|hear\s+back|onboarding|team\s+culture|interview\s+process)\b/

const QUESTION_AFTER_NO_RE =
  /\b(?:but|also|actually|one\s+thing|quick\s+question)\b.{0,160}\b(?:what|when|where|who|why|how|can|could|would|will|do|does|is|are|tell\s+me|next\s+steps|hear\s+back|onboarding|team\s+culture|interview\s+process)\b/

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifyWrapUpAnswer(text: string | null | undefined): WrapUpAnswerIntent {
  const raw = (text ?? '').trim()
  const normalized = normalize(raw)
  const isShortQuestion = raw.length <= 5 && QUESTION_PHRASE_RE.test(normalized)
  if (isShortQuestion) return 'has_question'
  if (raw.length <= 5) return 'empty'

  const hasNoQuestionIntent = NO_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))
  const asksQuestion = normalized.includes('?') || QUESTION_PHRASE_RE.test(normalized)
  const asksAfterNoQuestion = QUESTION_AFTER_NO_RE.test(normalized)

  if (asksQuestion && (!hasNoQuestionIntent || asksAfterNoQuestion || normalized.includes('?'))) {
    return 'has_question'
  }

  if (hasNoQuestionIntent) return 'no_questions'

  // Non-question wrap-up text gets a neutral close instead of "great question".
  return 'thank_you_only'
}

export function shouldAnswerWrapUpWithLLM(intent: WrapUpAnswerIntent): boolean {
  return intent === 'has_question'
}

export function buildWrapUpClosingLine(intent: WrapUpAnswerIntent, safeAnswer?: string): string {
  if (intent === 'has_question') {
    const answer = safeAnswer?.trim()
    return answer
      ? `${answer} ${WRAP_UP_REAL_QUESTION_SIGN_OFF}`
      : WRAP_UP_NO_QUESTIONS_CLOSE
  }

  if (intent === 'thank_you_only') return WRAP_UP_THANK_YOU_CLOSE

  return WRAP_UP_NO_QUESTIONS_CLOSE
}
