/**
 * Measure the size of the system prompt that /api/generate-question would
 * construct at Q1, Q5, Q10, Q15 of a simulated 30-min interview.
 *
 * Replicates the exact concatenation logic from
 * `app/api/generate-question/route.ts` (HEAD), block by block, so we can
 * see how each block contributes to growth.
 *
 * Output: a markdown table + per-block growth deltas.
 */

import { resolveFlow, buildFlowPromptContext, type ResolvedFlow } from '../modules/interview/flow'
import type { ThreadSummary, TranscriptEntry, PerformanceSignal } from '../shared/types'

// ─── Synthetic JD + Resume (~2500 chars each) ─────────────────────────────
const JD = `Senior Backend Engineer — Payments Platform.
We are looking for a senior backend engineer with 5+ years of production experience to join our Payments Platform team. You will own end-to-end services that move money for millions of users.
Must-have requirements:
  • 5+ years building distributed backend systems in Go, Java, or Rust
  • Strong incident response experience — comfortable being on-call for tier-0 services
  • Demonstrated ownership of CI/CD pipelines and observability tooling
  • Production experience with PostgreSQL or similar relational stores at scale
  • Experience leading cross-functional initiatives and driving consensus
Nice to have:
  • Prior fintech / payments experience (PCI scope, idempotency, double-entry bookkeeping)
  • Open source contributions to backend tools
  • Experience with Kafka or similar streaming infrastructure
What you'll do:
  • Design and ship payment-rail services with five-nines availability targets
  • Lead architectural decisions across multiple teams; mentor mid-level engineers
  • Drive incident response and postmortems; improve observability and SLO coverage
  • Own one or more sub-domains end-to-end: from initial design to production rollout to long-term maintenance
  • Partner with PMs, designers, and finance to shape the product roadmap
What we value:
  • Bias to action: we ship small, often, and learn from production
  • Engineering excellence: high test coverage, clear runbooks, low cognitive load
  • Direct communication: we say what we mean and welcome dissent
  • Long-term thinking: every system we build must remain maintainable for a decade
Compensation: competitive base, equity, full benefits. Hybrid (NYC / SF / remote-friendly).
About us: Payments Platform is the team that runs the wire that makes our marketplace work. Every dollar that flows through our product passes through code we own. We obsess about correctness, observability, and the boring details that prevent customer-impacting incidents.`

const RESUME = `Sarah Chen — Senior Backend Engineer — sarah@example.com — github.com/sarahchen
SUMMARY
  Senior backend engineer with 7 years of experience designing and operating distributed systems in fintech and ad-tech. Strong owner of incident response, observability, and developer-tooling investments.
EXPERIENCE
  Senior Backend Engineer @ FinPay (2022 — Present)
    • Owned re-architecture of card-network gateway; cut p99 latency 280ms → 95ms (66% reduction)
    • Led incident response for 4 sev-1 production events; co-authored 11 postmortems
    • Built canary deploy infrastructure adopted by 6 teams; eliminated rollback-related downtime
    • Mentored 3 mid-level engineers, two of whom were promoted within 18 months
    • Drove migration from PostgreSQL 12 → 14 across 18 services with zero customer-impacting downtime
  Backend Engineer @ AdMatch (2019 — 2022)
    • Owned bidder service handling 350k QPS at p99 < 30ms
    • Designed cross-region replication scheme using Postgres logical replication + Kafka
    • Co-led migration from in-house orchestrator to Kubernetes; reduced ops toil by ~40%
    • Mentored 2 junior engineers through their first production on-calls
  Software Engineer @ DataPipe (2017 — 2019)
    • Built ETL pipeline ingesting 2TB/day with at-most-once semantics and replay support
    • Implemented multi-tenant rate limiting using Redis token buckets
EDUCATION
  B.S. Computer Science — Carnegie Mellon University (2017) — GPA 3.85, Distinguished Major
SKILLS
  Languages: Go, Java, Python, Rust (intermediate), TypeScript
  Infrastructure: Kubernetes, Terraform, Docker, AWS (EC2, RDS, S3, Lambda, EKS), GCP
  Datastores: PostgreSQL (advanced), Redis, Kafka, DynamoDB, ElasticSearch, ClickHouse
  Tools: Datadog, PagerDuty, Sentry, Prometheus, Grafana, Jaeger, OpenTelemetry
PROJECTS / OPEN SOURCE
  • Contributed to pgx (PostgreSQL driver for Go) — 6 merged PRs around connection pooling
  • Authored "incidentctl" — internal tool for stitching together logs/traces/metrics during sev-1s
  • Conference talk: "Eliminating Rollback Downtime with Canaries" — Strange Loop 2023`

// ─── Synthetic ThreadSummary entries ──────────────────────────────────────
function thread(i: number): ThreadSummary {
  const topics = [
    'Walk me through your re-architecture of the card-network gateway',
    'Tell me about a sev-1 incident you led — what did you learn',
    'How did you build consensus during the PostgreSQL 12→14 migration',
    'Describe a time you mentored a junior who later got promoted',
    'Tell me about your work on the canary deploy infrastructure',
    'Walk me through a major architecture decision with cross-team impact',
    'Tell me about a conflict with another engineering manager',
    'Describe a project that did not go as planned',
    'How did you decide what to prioritize during the AdMatch migration',
    'Tell me about a postmortem that changed how your team operates',
    'Walk me through your most ambitious technical investment',
    'Describe a time you had to push back on a product requirement',
    'Tell me about a time you took on something outside your remit',
    'Describe how you grow direct reports who plateau',
  ]
  return {
    topicQuestion: topics[i % topics.length],
    summary: `Candidate described a ${300 + ((i * 17) % 100)}-line refactor across ${2 + (i % 4)} services; cut p99 latency by ${20 + (i * 3) % 40}% and reduced sev-1 incidents in the area by ${30 + (i % 5) * 5}% over the following quarter.`,
    avgScore: 55 + ((i * 7) % 35),
    probeCount: i % 3,
    company: i % 2 === 0 ? 'FinPay' : 'AdMatch',
  } as ThreadSummary
}

function previousQA(n: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      speaker: 'interviewer',
      text: `Question ${i + 1}: Tell me about a time when you had to make a difficult tradeoff between shipping a feature and addressing technical debt.`,
    } as TranscriptEntry)
    out.push({
      speaker: 'candidate',
      text: `In Q3 2023 we faced exactly this. The platform team needed me to ship the new payouts API by end-of-quarter, but our incident metrics showed three on-call alerts per week tied to a flaky retry handler. I made the call to spend two weeks fixing the retry handler first, and pushed the payouts ship date out by ten business days. I bought time by getting buy-in from the GM with a one-pager comparing on-call hours saved vs feature delay. The retry refactor cut alerts by 80% and the payouts API shipped without an incident in its first month.`,
    } as TranscriptEntry)
  }
  return out
}

// ─── Block builders — mirror generate-question/route.ts logic ─────────────
function basePromptFor(domain: string, depth: string, exp: string, duration: number, label: string): string {
  const typeLabels: Record<string, string> = {
    screening: 'HR screening interview',
    behavioral: 'behavioral deep-dive interview',
    technical: 'technical interview',
    'case-study': 'case study session',
  }
  const roleLabels: Record<string, string> = {
    screening: 'senior recruiter',
    behavioral: 'senior hiring manager focused on behavioral assessment',
    technical: 'technical interview lead',
    'case-study': 'strategy and case assessment lead',
  }
  const typeInstructions: Record<string, string> = {
    behavioral: 'Ask exclusively about PAST experiences using behavioral prompts ("Tell me about a time when...", "Describe a situation where..."). Every question must probe a real event the candidate lived through. Never ask hypothetical scenarios.',
  }
  return `You are Alex Chen, a ${roleLabels[depth]}. You are conducting a ${duration}-minute ${typeLabels[depth]} for a ${label} role (${exp} years experience).

QUESTION FORMAT: ${typeInstructions[depth] || 'Ask one focused question at a time.'}`
}

function jdBlock(jdRaw: string): string {
  // The structured-context path is gated on Mongo lookups; for the worst-case
  // measurement we use the .slice() raw-fallback path that's most common.
  return `\n\n<job_description>\n${jdRaw.slice(0, 2500)}\n</job_description>\nPRIORITY: The job description above defines the requirements this interview MUST assess. At least 60% of your questions should directly probe skills, qualifications, and responsibilities listed in the JD. Use the candidate's resume as evidence for or against JD requirements — not as the primary source of topics.`
}

function resumeBlock(resumeRaw: string): string {
  return `\n\n<candidate_resume>\n${resumeRaw.slice(0, 2500)}\n</candidate_resume>\nProbe specific experiences, projects, and claims from the resume above. Ask for concrete details.`
}

function crossRefBlock(): string {
  return `\n\nCROSS-REFERENCE STRATEGY: Map the candidate's resume experiences to JD requirements. Prioritize probing gaps — areas where the JD requires something the resume doesn't clearly demonstrate. When the resume DOES match a JD requirement, ask for specific evidence, metrics, and depth. Your questions should systematically cover JD requirements, using the resume as a lens to assess fit.`
}

function profileBlock(): string {
  return [
    `\nThe candidate's current title is: Senior Backend Engineer.`,
    ` They work in the Fintech industry.`,
    ` They have been in their current role for 3 years.`,
    `\nSpecific target companies: Stripe, Plaid, Brex. Tailor questions to the culture and interview style of these companies.`,
    `\nThe candidate wants to improve: incident response, executive communication. Naturally weave in questions that test these areas.`,
    `\nCandidate's top skills: Go, PostgreSQL, distributed systems, observability. Probe these to validate depth.`,
  ].join('')
}

function threadContextBlock(threads: ThreadSummary[], jdPresent: boolean): string {
  if (!threads.length) return ''
  const summaries = threads.map((t, i) =>
    `Topic ${i + 1}: "${t.topicQuestion}" (avg score: ${t.avgScore}, probes: ${t.probeCount})`
  ).join('\n')
  const diversityNote = threads.length >= 3
    ? `\nIMPORTANT: You have already covered ${threads.length} topics. Ensure your next question explores a DIFFERENT competency area (e.g., if past questions focused on leadership and stakeholder management, now ask about technical depth, failure handling, data-driven decisions, or innovation). Variety across competencies is critical for a thorough assessment.`
    : ''
  const jdCoverageNote = jdPresent
    ? `\n\nJD COVERAGE CHECK: Review the JD requirements above. Identify which requirements have NOT yet been assessed by the topics already covered. Your next question MUST target an uncovered JD requirement.`
    : ''
  let block = `\n\nTOPICS ALREADY COVERED:\n${summaries}\n\nDo NOT repeat these topics.${diversityNote}${jdCoverageNote} You MAY occasionally reference a pattern across topics when a genuine link exists. Use cross-references sparingly.`
  // Employer rotation
  const employers = ['FinPay', 'AdMatch', 'DataPipe']
  const covered = Array.from(new Set(threads.map(t => t.company).filter(Boolean) as string[]))
  const uncovered = employers.filter(c => !covered.some(uc => uc.toLowerCase() === c.toLowerCase()))
  if (uncovered.length > 0) {
    block += `\n\nEMPLOYER DIVERSITY: The candidate has worked at: ${employers.join(', ')}. Previous questions covered: ${covered.join(', ') || 'none specifically'}. You MUST ask about a DIFFERENT employer next. Focus your next question on the candidate's experience at ${uncovered.slice(0, 2).join(' or ')}. Do NOT ask another question about ${covered[covered.length - 1] || employers[0]}.`
  }
  return block
}

function recallBlock(threads: ThreadSummary[]): string {
  if (threads.length < 2) return ''
  const recallPoints = threads.slice(-4).map((t, i) =>
    `Q${i + 1}: "${t.topicQuestion.slice(0, 80)}" → Key takeaway: "${t.summary.slice(0, 120)}"`
  ).join('\n')
  return `\n\nCANDIDATE'S PREVIOUS ANSWERS (use for continuity and cross-referencing):
${recallPoints}

When relevant, reference what the candidate said earlier with natural transitions like:
- "You mentioned [X] earlier — building on that..."
- "Coming back to what you said about [Y]..."
- "That connects to something you shared earlier about [Z]..."
Do this only when a genuine link exists (roughly 1 in 3 questions). Do NOT force cross-references.`
}

function flowBlockFor(qIdx: number, completed: ThreadSummary[]): string {
  const flow = resolveFlow({ domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 30 })!
  const slotIdx = Math.min(completed.length, flow.totalSlots - 1)
  const ctx = buildFlowPromptContext({
    flow,
    currentSlotIndex: slotIdx,
    completedThreads: completed,
    performanceSignal: 'on_track' as PerformanceSignal,
  })
  return ctx.promptBlock ? `\n\n${ctx.promptBlock}` : ''
}

function userPromptFor(qIdx: number, totalQ: number): string {
  return `Generate question ${qIdx + 1} of ${totalQ}.

Return ONLY the question text. No preamble, no numbering, no quotation marks. Just the question.`
}

// ─── Main ─────────────────────────────────────────────────────────────────
const QS = [1, 5, 10, 15] // 1-indexed Q
const totalQ = 16 // 30-min budget

interface Row {
  q: number
  base: number
  jd: number
  resume: number
  crossRef: number
  profile: number
  thread: number
  recall: number
  flow: number
  user: number
  total: number
}

const rows: Row[] = []

for (const q of QS) {
  const completed = Array.from({ length: q - 1 }, (_, i) => thread(i))
  const base = basePromptFor('backend', 'behavioral', '3-6', 30, 'Backend Engineer')
  const jd = jdBlock(JD)
  const resume = resumeBlock(RESUME)
  const cross = crossRefBlock()
  const profile = profileBlock()
  const thread_ = threadContextBlock(completed, true)
  const recall = recallBlock(completed)
  const flow = flowBlockFor(q - 1, completed)
  const user = userPromptFor(q - 1, totalQ)

  const total = base.length + jd.length + resume.length + cross.length + profile.length +
                thread_.length + recall.length + flow.length + user.length

  rows.push({
    q,
    base: base.length,
    jd: jd.length,
    resume: resume.length,
    crossRef: cross.length,
    profile: profile.length,
    thread: thread_.length,
    recall: recall.length,
    flow: flow.length,
    user: user.length,
    total,
  })
}

// Print table
console.log('\n# Prompt Size Measurement — backend × behavioral × 3-6 × 30 min')
console.log('All sizes in chars. Token est. = chars / 4 (rough).\n')
console.log('| Q   | base | JD   | resume | xref | profile | thread | recall | flow | user | TOTAL  | tokens |')
console.log('|-----|------|------|--------|------|---------|--------|--------|------|------|--------|--------|')
for (const r of rows) {
  const tk = Math.round(r.total / 4)
  console.log(
    `| Q${String(r.q).padStart(2)} | ${String(r.base).padStart(4)} | ${String(r.jd).padStart(4)} | ` +
    `${String(r.resume).padStart(6)} | ${String(r.crossRef).padStart(4)} | ${String(r.profile).padStart(7)} | ` +
    `${String(r.thread).padStart(6)} | ${String(r.recall).padStart(6)} | ${String(r.flow).padStart(4)} | ` +
    `${String(r.user).padStart(4)} | ${String(r.total).padStart(6)} | ${String(tk).padStart(6)} |`,
  )
}

// Growth deltas
const q1 = rows[0]
const q15 = rows[rows.length - 1]
console.log('\n## Growth Q1 → Q15 (per block)')
const deltas: Array<[string, number]> = [
  ['base',     q15.base - q1.base],
  ['JD',       q15.jd - q1.jd],
  ['resume',   q15.resume - q1.resume],
  ['xref',     q15.crossRef - q1.crossRef],
  ['profile',  q15.profile - q1.profile],
  ['thread',   q15.thread - q1.thread],
  ['recall',   q15.recall - q1.recall],
  ['flow',     q15.flow - q1.flow],
  ['user',     q15.user - q1.user],
  ['TOTAL',    q15.total - q1.total],
]
for (const [name, d] of deltas) {
  console.log(`  ${name.padEnd(8)} +${d} chars (~${Math.round(d / 4)} tokens)`)
}

const dominant = deltas.slice(0, -1).sort((a, b) => b[1] - a[1])[0]
console.log(`\n## Dominant growth driver Q1→Q15: ${dominant[0]} (+${dominant[1]} chars)`)

// Per-block size at Q15 (which block is largest)
console.log('\n## Block sizes at Q15 (descending)')
const q15Blocks: Array<[string, number]> = [
  ['base', q15.base],
  ['JD', q15.jd],
  ['resume', q15.resume],
  ['xref', q15.crossRef],
  ['profile', q15.profile],
  ['thread', q15.thread],
  ['recall', q15.recall],
  ['flow', q15.flow],
  ['user', q15.user],
]
q15Blocks.sort((a, b) => b[1] - a[1])
for (const [name, sz] of q15Blocks) {
  console.log(`  ${name.padEnd(8)} ${sz} chars`)
}
