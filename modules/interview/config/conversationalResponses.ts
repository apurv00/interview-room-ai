// ─── Conversational Interview Responses ─────────────────────────────────────
// Transforms the interview from rigid Q&A into natural conversation.
// classifyIntent() runs locally (~1ms, no API) after each candidate utterance.
// Response arrays provide pre-built natural replies for non-answer intents.

export type CandidateIntent = 'answer' | 'clarification' | 'redirect' | 'question' | 'thinking'

/**
 * Classify candidate speech intent. Local regex — no API call, <1ms.
 * Safe default: anything unrecognized → 'answer' (existing evaluation flow).
 */
export function classifyIntent(text: string): CandidateIntent {
  const lower = text.toLowerCase().trim()
  if (!lower) return 'answer'

  // Thinking starters — candidate buying time (only if short, otherwise they started answering)
  if (
    /^(hmm|um+|uh+|let me think|that's a (great|good|interesting|tough|hard) question|good question|okay let me)/i.test(lower) &&
    lower.length < 50
  ) {
    return 'thinking'
  }

  // Clarification requests
  if (
    /can you (repeat|rephrase|say that again|clarify|explain)|what do you mean|i('m| am) not sure i understand|could you (explain|rephrase|elaborate on (the|that) question)|sorry,? (i|what)|i didn('t| not) (catch|get|hear|understand) that/i.test(lower)
  ) {
    return 'clarification'
  }

  // Redirect — candidate wants to change their answer
  if (
    /can i (give|share|use|try) (a |an )?(different|another|better) (example|story|answer|one)|let me (try|start) (again|over|fresh)|actually,? (can i|let me|i('d| would) like to)/i.test(lower)
  ) {
    return 'redirect'
  }

  // Proactive candidate question — short, ends with "?", not a rhetorical STAR answer
  // Exclude sentences that start with personal pronouns (likely part of an answer)
  if (
    lower.endsWith('?') &&
    lower.length < 120 &&
    !/^(so |and |but |because )?(i |we |my |our |the team )/i.test(lower)
  ) {
    return 'question'
  }

  return 'answer'
}

// ─── Pre-built Responses ────────────────────────────────────────────────────

export const CONVERSATION_RESPONSES = {
  clarification: [
    "Of course! Let me put it differently —",
    "Sure, let me rephrase that —",
    "Great question. What I'm really asking is —",
    "Absolutely. Let me frame it another way —",
  ],
  redirect: [
    "Of course, go ahead with a different example.",
    "Sure! Share whichever experience feels most relevant.",
    "No problem — take it from wherever you'd like.",
  ],
  thinking: [
    "Take your time.",
    "No rush at all.",
    "Of course — think it through.",
  ],
} as const

/**
 * Simplify a question for rephrasing. Strips formal framing and returns the core ask.
 * Used when candidate says "Can you repeat that?" — interviewer paraphrases, not repeats.
 */
export function simplifyQuestion(question: string): string {
  // Strip common interview question prefixes
  let simplified = question
    .replace(/^(tell me about a time when|describe a situation where|can you walk me through|walk me through|think about a time when|share an experience where)/i, '')
    .replace(/^(imagine you are|imagine you're|let's say you are|suppose you are|you are the)/i, 'As')
    .trim()

  // Ensure it starts with a capital letter
  if (simplified.length > 0) {
    simplified = simplified.charAt(0).toUpperCase() + simplified.slice(1)
  }

  return simplified || question
}

/** Pick a random item from an array. */
export function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
