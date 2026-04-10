// ─── Conversational Interview Responses ─────────────────────────────────────
// Transforms the interview from rigid Q&A into natural conversation.
// classifyIntent() runs locally (~1ms, no API) after each candidate utterance.
// Response arrays provide pre-built natural replies for non-answer intents.
//
// Intent priority (first match wins):
//   1. distress     — emotional signals get immediate support
//   2. repetition   — explicit re-ask requests
//   3. correction   — "scratch that / let me restart"
//   4. timecheck    — "how much time do I have?"
//   5. hint         — "give me a hint"
//   6. thinking     — filler / stalling (short utterances only)
//   7. clarification— "can you rephrase?"
//   8. challenge_question — "that's not a fair question" (E4)
//   9. gaming       — "just tell me the right answer" (E8)
//  10. redirect     — "can I try a different example?"
//  11. question     — candidate asks interviewer something
//  12. answer       — default: everything else goes to evaluation

export type CandidateIntent =
  | 'answer'
  | 'clarification'
  | 'redirect'
  | 'question'
  | 'thinking'
  | 'distress'
  | 'correction'
  | 'repetition'
  | 'timecheck'
  | 'hint'
  | 'challenge_question'
  | 'gaming'

/**
 * Classify candidate speech intent. Local regex — no API call, <1ms.
 * Safe default: anything unrecognized → 'answer' (existing evaluation flow).
 *
 * Priority ordering prevents misrouting: distress and repetition are checked
 * first because they need immediate non-evaluative handling. Longer utterances
 * (>80 chars) skip most non-answer intents to avoid intercepting real answers
 * that happen to contain trigger phrases.
 */
export function classifyIntent(text: string): CandidateIntent {
  const lower = text.toLowerCase().trim()
  if (!lower) return 'answer'

  // ── 1. Distress — emotional signals (short utterances only to avoid false positives)
  if (
    lower.length < 80 &&
    /i('m| am) (blanking|drawing a blank|nervous|anxious|panicking|so nervous|really nervous|lost|stressed|freaking out)|i forgot everything|my mind (went|is going|just went) blank|i (can't|cannot) think|i need a (second|moment|minute)|i('m| am) sorry,? i/i.test(lower)
  ) {
    return 'distress'
  }

  // ── 2. Repetition — explicit re-ask requests
  if (
    lower.length < 80 &&
    /can you (repeat|re-?read|say that again)|what was the question|could you (re-?ask|repeat)|say that (one )?again|i missed (that|the question)|repeat the question/i.test(lower)
  ) {
    return 'repetition'
  }

  // ── 3. Correction — candidate wants to restart their current answer
  if (
    lower.length < 80 &&
    /(actually,? )?let me (restart|rephrase|redo|start over|try that again)|wait,? i made an? error|scratch that|ignore (that|what i (just )?said)|let me take that back|sorry,? let me (redo|rephrase|restart)|i('d| would) like to rephrase/i.test(lower)
  ) {
    return 'correction'
  }

  // ── 4. Time check — session pacing query
  if (
    lower.length < 60 &&
    /how much time (do i|do we|is) (have |left|remaining)|how long do i have|am i (going|running) too slow|am i on track (time|pace)/i.test(lower)
  ) {
    return 'timecheck'
  }

  // ── 5. Hint request
  if (
    lower.length < 80 &&
    /give me a hint|can (you|i) (get|have) a hint|point me in the right direction|what should i focus on|where should i start|any hints/i.test(lower)
  ) {
    return 'hint'
  }

  // ── 6. Thinking starters — candidate buying time (only if short)
  if (
    /^(hmm|um+|uh+|let me think|that's a (great|good|interesting|tough|hard) question|good question|okay let me)/i.test(lower) &&
    lower.length < 50
  ) {
    return 'thinking'
  }

  // ── 7. Clarification requests
  if (
    /can you (repeat|rephrase|say that again|clarify|explain)|what do you mean|i('m| am) not sure i understand|could you (explain|rephrase|elaborate on (the|that) question)|sorry,? (i|what)|i didn('t| not) (catch|get|hear|understand) that/i.test(lower)
  ) {
    return 'clarification'
  }

  // ── 8. Challenge question — candidate pushes back on the question itself (E4)
  if (
    lower.length < 80 &&
    /that('s| is) (not )?(a )?(fair|valid|relevant|appropriate|good) question|this question (is|seems) (flawed|unfair|irrelevant|biased)|i don('t| not) (think|see how) that('s| is) relevant|that doesn('t| not) apply to my role|why (are you|would you) ask(ing)? (that|this)/i.test(lower)
  ) {
    return 'challenge_question'
  }

  // ── 9. Gaming — candidate tries to extract the answer (E8)
  // Must be checked BEFORE 'question' intent (priority) since gaming phrases end with "?"
  if (
    lower.length < 60 &&
    /(just )?tell me (the|what the) (right|correct|best) answer|what (should i|do you want me to|are you looking for me to) say|what('s| is| are) (the right|you looking for)|tell me what you want to hear|can you just give me the answer/i.test(lower)
  ) {
    return 'gaming'
  }

  // ── 10. Redirect — candidate wants to change their answer (short utterances only)
  if (
    lower.length < 80 &&
    /can i (give|share|use|try) (a |an )?(different|another|better) (example|story|answer|one)|let me (try|start) (again|over|fresh)|actually,? (can i|let me|i('d| would) like to)/i.test(lower)
  ) {
    return 'redirect'
  }

  // ── 9. Proactive candidate question — short, ends with "?", not a rhetorical STAR answer
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
    "Sure, take a moment.",
  ],
  distress: [
    "Take a breath — that's completely normal. Whenever you're ready.",
    "No rush at all. It's okay to gather your thoughts.",
    "That happens to everyone. Take a moment and we'll pick up whenever you're ready.",
    "Totally fine — interviews can be intense. Just let me know when you'd like to continue.",
  ],
  correction: [
    "Of course, go right ahead.",
    "Sure — please continue.",
    "No problem, take it from the top.",
    "Absolutely — go ahead and rephrase.",
  ],
  repetition: [
    "Sure — let me re-read that for you.",
    "Of course.",
    "No problem.",
    "Absolutely — here it is again.",
  ],
  hint: {
    behavioral: "I can't give you a direct hint, but think about a specific situation — what was the context, what did you do, and what happened as a result?",
    technical: "Here's a nudge: think about the trade-offs involved — what are the key constraints you'd need to balance?",
    'case-study': "Think about what framework might apply to a problem like this — start with structuring your approach.",
    screening: "Focus on what makes you a strong fit — what's the most relevant experience you can draw on?",
  },
  timecheck: (minutesLeft: number, isStrong: boolean) =>
    minutesLeft >= 1
      ? `You have about ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} left — ${isStrong ? "you're doing great on pace" : "you're doing fine"}.`
      : "We're almost at time — wrap up your current thought.",
  challenge_question: [
    "Fair point. Let me reframe that.",
    "I hear you. Let me approach this differently.",
    "That's a valid perspective. Let me adjust the question.",
    "Good pushback. Let me put it another way.",
  ],
  gaming: [
    "I'm really interested in YOUR perspective here. There's no single right answer.",
    "This is about how you think through problems, not about a specific answer. Walk me through your approach.",
    "There's no script here. I want to hear how you'd genuinely handle this.",
    "What matters is your reasoning, not a perfect answer. Give it your best shot.",
  ],
  dontKnow: {
    probe: [
      "That's okay — what part of this are you most confident about?",
      "No worries — what would your first instinct be, even if you're not certain?",
      "Fair enough — is there a related experience you could draw on?",
    ],
    advance: [
      "That's completely fine. Let's move to something else.",
      "No problem at all — let's try a different angle.",
    ],
  },
} as const

// ─── Richer Acknowledgement Utterances (TN5) ────────────────────────────────

export const THINKING_ACKS = [
  'Got it.', 'Mm-hmm.', 'Interesting.', 'I see.',
  'Alright.', 'Okay.', 'Right.', 'Sure.',
  'Understood.', 'Good.', 'Fair enough.', 'Makes sense.',
  'Noted.', 'Okay, noted.', 'Got it, thanks.',
] as const

export const PRE_QUESTION_FILLERS = [
  'Alright, let me ask you about something different.',
  'So, shifting gears a bit —',
  'Good. Next question for you.',
  'Okay, let me move on to something else.',
  "Let's talk about a different area.",
] as const

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
