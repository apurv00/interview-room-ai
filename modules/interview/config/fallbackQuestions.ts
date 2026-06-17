// ─── Fallback Interview Questions ────────────────────────────────────────────
// Pool of behavioral questions used when the AI question-generation API fails.
// This runs CLIENT-SIDE precisely when the API/network is degraded, so it must be
// fully static (no fetch). Questions are grouped by the domain's category so a
// degraded interview still feels role-appropriate, not generic. Falls back to a
// universal pool when the domain/category is unknown.

import { STATIC_DOMAINS } from './staticData'

// Universal pool — used for the 'general' domain and as the ultimate fallback.
export const FALLBACK_QUESTIONS: readonly string[] = [
  'Tell me about a challenge you faced recently and how you handled it.',
  'Describe a time when you had to collaborate with a difficult team member. What was the outcome?',
  'Walk me through a situation where you had to learn something new quickly to complete a project.',
  'Tell me about a time you received critical feedback. How did you respond?',
  'Describe a project where things did not go as planned. What did you do to get back on track?',
  'Can you share an example of when you had to make a decision with incomplete information?',
  'Tell me about a time you took initiative on something outside your usual responsibilities.',
  'Describe a situation where you had to prioritize competing deadlines. How did you decide what came first?',
  'Walk me through an accomplishment you are particularly proud of and why it mattered.',
  'Tell me about a time you had to persuade someone to see things from your perspective.',
]

// Category-specific behavioral pools (keyed by Category.slug from the taxonomy).
const FALLBACK_BY_CATEGORY: Record<string, readonly string[]> = {
  programming: [
    'Tell me about a challenging bug or production issue you tracked down. How did you approach it?',
    'Describe a technical decision you made and the tradeoffs you weighed.',
    'Tell me about a time you had to learn a new technology or codebase quickly to ship something.',
    'Describe a time you disagreed with a teammate on a technical approach. What happened?',
    'Walk me through a time you improved the reliability or performance of something you owned.',
  ],
  'data-ai': [
    'Tell me about an analysis or model whose result changed a decision.',
    'Describe a time your data or model was wrong. How did you catch it?',
    'Walk me through how you validated an experiment or a model before trusting it.',
    'Tell me about explaining a technical result to a non-technical stakeholder.',
    'Describe a time you had to work with messy or incomplete data. What did you do?',
  ],
  'core-engineering': [
    'Tell me about an engineering project you owned end to end. What was your role?',
    'Describe a time safety or reliability was at odds with the schedule. What did you do?',
    'Walk me through a design decision where you had to balance cost and performance.',
    'Tell me about a failure or defect you investigated. How did you find the root cause?',
    'Describe a time you had to coordinate across disciplines to deliver a project.',
  ],
  product: [
    'Tell me about a product decision you made with incomplete information.',
    'Describe how you prioritized between competing features or stakeholders.',
    'Tell me about a metric you moved and how you knew the change worked.',
    'Describe a time you said no to a stakeholder. How did you handle it?',
    'Walk me through a time you used data or user feedback to change direction.',
  ],
  design: [
    "Walk me through a design you're proud of, from the problem to the outcome.",
    'Tell me about a time you received tough design critique. How did you respond?',
    'Describe how you balanced user needs against business or technical constraints.',
    'Tell me about a time research changed your design direction.',
    'Describe a time you had to advocate for the user against pushback.',
  ],
  business: [
    'Tell me about a recommendation you made that drove a measurable business outcome.',
    'Describe a time you had to influence a decision without direct authority.',
    'Walk me through how you handled a target or number you were at risk of missing.',
    'Tell me about a difficult tradeoff you made under resource constraints.',
    'Describe a time you turned around a struggling project, account, or process.',
  ],
}

// domain slug → category slug, from the single source of truth.
const DOMAIN_CATEGORY: Record<string, string> = Object.fromEntries(
  STATIC_DOMAINS.filter(d => d.categorySlug).map(d => [d.slug, d.categorySlug as string]),
)

/** Resolve the appropriate fallback pool for a domain (category-aware). */
function poolFor(domain?: string): readonly string[] {
  if (!domain) return FALLBACK_QUESTIONS
  const category = DOMAIN_CATEGORY[domain]
  return (category && FALLBACK_BY_CATEGORY[category]) || FALLBACK_QUESTIONS
}

/**
 * Returns the next unused fallback question, scoped to the candidate's domain when known
 * so a degraded interview stays role-appropriate. Tracks used questions by their TEXT
 * (not pool index) so the set stays correct even if the resolved pool changes between
 * calls — e.g. the first failure fires before `config.role` has hydrated (universal pool)
 * and later calls resolve a domain pool. Resets only when the current pool is exhausted.
 */
export function getNextFallbackQuestion(used: Set<string>, domain?: string): string {
  const pool = poolFor(domain)

  // Reset once every question in the CURRENT pool has been served. (A pool change needs
  // no special handling: the new pool's questions simply aren't in `used` yet.)
  if (pool.every((q) => used.has(q))) {
    used.clear()
  }

  for (const q of pool) {
    if (!used.has(q)) {
      used.add(q)
      return q
    }
  }

  // Shouldn't reach here, but safe default.
  return pool[0]
}
