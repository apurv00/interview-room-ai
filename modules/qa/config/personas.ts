import type { InterviewDepth, PersonaKind } from '../agent/types'

const STRONG_BEHAVIORAL =
  'At Acme I led a cross-functional launch that cut checkout drop-off by 38% in six weeks. I owned the daily stand-up, aligned engineering and design on a single success metric, and escalated a vendor API blocker to our Stripe rep. We recovered an estimated $150k in the first month. I learned that agreeing on the metric upfront made every trade-off easier.'

const WEAK_BEHAVIORAL =
  'I worked on a project with my team and we improved things. There were some challenges but we figured it out. I think it went well overall and stakeholders were happy.'

const STRONG_TECHNICAL =
  'We migrated a monolith checkout service to event-driven microservices on Kafka. I designed idempotent consumers, added DLQs for poison messages, and cut p99 latency from 800ms to 120ms. Rollout was phased with feature flags and automated rollback on error-budget burn.'

const WEAK_TECHNICAL =
  'We moved to microservices and used Kafka. It was faster and more scalable. We deployed with CI/CD.'

const STRONG_CASE =
  "I will structure this: goal was 15% MAU growth in Q3. I sized the market at 2M users, assumed 8% conversion from top-of-funnel, and prioritized two bets — referral loop and onboarding checklist. Expected impact +3.2pp conversion, ROI positive in 6 weeks."

const WEAK_CASE =
  'I would grow users with marketing and improve the product. Maybe partnerships too.'

const STRONG_SYSTEM_DESIGN =
  "Requirements: 10M DAU, 5k write RPS, 50k read RPS, 99.9% availability. I would use a CDN for static assets, stateless API pods behind a load balancer, PostgreSQL primary with read replicas for profiles, Redis for session cache, and S3 for media. Async workers via SQS for notifications. Trade-off: eventual consistency on feed reads vs strong consistency on payments."

const WEAK_SYSTEM_DESIGN =
  'I would use a load balancer and database and cache. Scale horizontally. Microservices if needed.'

const STRONG_CODING =
  'I will use a hash map to count frequencies in O(n) time and O(k) space. Handle empty input, unicode if needed, and return entries sorted by count. Edge cases: single element, all duplicates.'

const WEAK_CODING =
  'Maybe loop through and count. Hash map probably.'

const TEMPLATES: Record<InterviewDepth, Record<PersonaKind, string>> = {
  behavioral: { strong: STRONG_BEHAVIORAL, weak: WEAK_BEHAVIORAL },
  technical: { strong: STRONG_TECHNICAL, weak: WEAK_TECHNICAL },
  'case-study': { strong: STRONG_CASE, weak: WEAK_CASE },
  'system-design': { strong: STRONG_SYSTEM_DESIGN, weak: WEAK_SYSTEM_DESIGN },
  coding: { strong: STRONG_CODING, weak: WEAK_CODING },
}

const IMPROVED_DRILL_SUFFIX =
  ' To be concrete: I defined the metric upfront, quantified impact with before/after numbers, named my specific ownership, and closed with a lesson learned.'

export function pickPersonaAnswer(
  depth: InterviewDepth,
  persona: PersonaKind,
  question: string,
): string {
  const base = TEMPLATES[depth]?.[persona] ?? TEMPLATES.behavioral[persona]
  const hook = question.length > 80 ? `Regarding "${question.slice(0, 80)}...", ` : ''
  return `${hook}${base}`
}

export function pickImprovedDrillAnswer(originalAnswer: string, depth: InterviewDepth): string {
  const strong = TEMPLATES[depth]?.strong ?? STRONG_BEHAVIORAL
  return `${strong} ${IMPROVED_DRILL_SUFFIX} (Revision of prior attempt: ${originalAnswer.slice(0, 120)}...)`
}

export function questionQualityHeuristics(question: string, domain: string, depth: InterviewDepth): string[] {
  const issues: string[] = []
  if (question.length < 20) issues.push('Question unusually short')
  if (/\bPm\b/.test(question)) issues.push('Domain label "Pm" leaked into question text')
  for (const re of [/as an ai/i, /language model/i, /\bprompt\b/i]) {
    if (re.test(question)) issues.push(`Template leakage: ${re.source}`)
  }
  if (depth === 'coding' && !/(code|implement|algorithm|function|complexity|test)/i.test(question)) {
    issues.push('Coding depth but question lacks implementation cues')
  }
  if (depth === 'system-design' && !/(design|scale|architect|trade|component|system)/i.test(question)) {
    issues.push('System-design depth but question lacks architecture cues')
  }
  if (depth === 'case-study' && !/(estimate|framework|approach|scenario|calculate)/i.test(question)) {
    issues.push('Case-study depth but question lacks structured reasoning cues')
  }
  if (!question.toLowerCase().includes(domain.slice(0, 3)) && domain !== 'general') {
    // soft signal only — many good questions won't mention slug
  }
  return issues
}
