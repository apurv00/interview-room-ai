/**
 * Academics-round prompt fragments.
 *
 * The favourite-subject question is the SPOKEN intro for academics
 * (`getInterviewIntro` in interviewConfig.ts), not a generated question. Q1 is
 * prefetched before the candidate's intro answer is captured (intentional — see
 * commit d2c04c9: "Q1 is the generic roadmap warm-up slot"), so at Q1-gen time the
 * named subject is not yet in the prompt. Without an explicit anti-repeat guard the
 * model fell back to re-asking the opener — the academics question-duplication bug.
 *
 * `academicGroundingDirective` is the single source of that guard. It is injected
 * into the generate-question system prompt (app/api/generate-question/route.ts) ahead
 * of the skill-file content so it frames the persona + style examples.
 */

/**
 * The subject-grounding + anti-repeat directive for academics interviews.
 * Returns '' for every other interview type (so the prompt is unchanged elsewhere).
 */
export function academicGroundingDirective(interviewType?: string): string {
  if (interviewType !== 'academics') return ''

  return `\n\nACADEMIC ROUND — SUBJECT GROUNDING (the most important rule): The candidate names their single strongest subject in their FIRST answer (the spoken opening already asked them "which academic subject are you strongest in, or enjoy the most?"). Identify that exact subject and anchor the ENTIRE round to it — every question must probe THAT subject's fundamentals first, and only later subjects DIRECTLY adjacent to it. NEVER switch to a different syllabus subject the candidate did not choose: if they said "digital marketing", ask about digital marketing (funnels, CAC/LTV, attribution, SEO/SEM) — not consumer behaviour or branding. If they said "operating systems", ask about OS — not DBMS. Read their first answer carefully and stay on their subject. Ask specific, well-formed questions that a candidate could answer in 1-2 minutes; one concept at a time. CRITICAL — NEVER RE-ASK THE OPENER: the question "which subject are you strongest in / which is your favourite subject" was ALREADY asked aloud as the opening of this interview. Do NOT ask it again in any rephrasing — that duplicates the opener and is the single worst failure of this round. If the candidate's named subject is not yet visible in the conversation above (this happens only on the very first question you generate, before their opening answer is in context), open with a light warm-up that asks them to sketch a quick roadmap of the main topics WITHIN the subject they just named — never ask them which subject to pick.`
}
