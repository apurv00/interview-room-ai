import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

const entry: CompactSlot[] = [
  ['metrics-definition', 'Metrics definition', 'data-driven', 'warm-up', 'must', 0,
    'Ask "You launched feature X. What metrics would you track?" Distinguish vanity from actionable.',
    'Probe "That metric went up but users are churning — what happened?"',
    'Structured thinking, not domain expertise.'],
  ['fermi-estimation', 'Fermi estimation problem', 'analytical', 'exploration', 'must', 2,
    'Ask a structured estimation question. Look for decomposition, stated assumptions, sanity-check.',
    'Probe "Your estimate seems high — what assumption would you revisit?"',
    'Estimation questions appear more frequently at APM than any other PM level.'],
  ['funnel-analysis', 'Funnel analysis', 'analytical', 'exploration', 'must', 2,
    'Present a conversion drop scenario. Look for user journey stage isolation.',
    'Probe segmentation thinking: new vs returning, platform, geo.'],
  ['ab-testing-basics', 'A/B testing fundamentals', 'experimentation', 'exploration', 'must', 2,
    'Ask to design an experiment. Look for hypothesis, control/treatment, success + guardrail metrics.',
    'Probe novelty effect, sample size awareness — not statistical depth.',
    'NOT forgiven for not knowing what A/B testing is.'],
  ['api-system-basics', 'API and system basics', 'technical-literacy', 'exploration', 'if-time', 1,
    'Ask "What happens when you type a URL?" or explain an API to a non-technical stakeholder.',
    'Probe baseline technical literacy, not depth.'],
  ['root-cause-analysis', 'Root cause analysis', 'analytical', 'exploration', 'if-time', 1,
    'Present a performance issue. Look for structured hypothesis generation across client/server.',
    'Probe "No data warehouse access yet — how do you get signal?"'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['tradeoff-simple', 'Simple tradeoff discussion', 'technical-literacy', 'closing', 'must', 0,
    'Ask about a build vs third-party decision. Look for pros/cons reasoning.',
    'Surface — not deep architecture, just structured thinking.'],
]

// Mid-level (3-6 yrs) slots.
//
// 2026-04-22 Bug C rebalance: the prior definition made all four mandatory
// exploration slots data/metrics-themed (metrics-framework, experiment-
// design, ambiguous-data, funnel-at-scale). Candidates running multiple
// sessions reported that questions felt like variations of the same
// north-star/cohort/AB-test discussion — seven sessions on 2026-04-21 →
// 2026-04-22 all converged on metric diagnosis as Q2-Q5. The LLM wasn't
// drifting on its own; it was following template guidance that told it
// to ask four consecutive metric questions.
//
// The rebalance keeps the two canonical signature slots (metrics-framework
// as warm-up, ambiguous-data as the "ship or not" tradeoff) and replaces
// experiment-design / funnel-at-scale as mandatory with two new
// non-metric mandatory slots (prioritization under constraints, scoping
// an ambiguous problem). The replaced slots remain available as `if-time`
// so sessions with bandwidth still cover them. Net: a mid-level session
// now reliably covers two metric questions, one prioritization, one
// scoping — a mix closer to what real PM interviews feel like.
const mid: CompactSlot[] = [
  ['metrics-framework', 'Metrics framework design', 'data-driven', 'warm-up', 'must', 0,
    'Ask "You own Instagram Reels. Design the metrics framework." North star → input → guardrails.',
    'Surface — calibrate metrics sophistication.', 'Shift from knowing A/B to running messy ones.'],
  ['prioritization-tradeoffs', 'Prioritization under constraints', 'product-sense', 'exploration', 'must', 2,
    'Present 3 competing product requests (tech-debt paydown, large customer feature, internal tooling) against a single quarterly goal and limited eng capacity. Ask how the candidate would sequence them and defend the order. Look for an explicit framework (RICE, effort/impact, strategic fit) AND a stated tradeoff — what they are deliberately deprioritizing.',
    'Probe "What if the lowest-priority one came from the CEO — does your order change?" and "How would you communicate the deprioritization to the team that lost?"',
    'Mid-level PMs are expected to defend priorities without waiting for approval and communicate tradeoffs upward.'],
  ['ambiguous-data', 'Interpreting ambiguous data', 'data-driven', 'exploration', 'must', 2,
    'Present conflicting metrics: "+2% conversion but -5% revenue per user. Ship?" THE signature question.',
    'Probe lurking variables, conviction, and guardrail awareness.',
    'The canonical mid-level PM technical question.'],
  ['scoping-under-uncertainty', 'Scoping an ambiguous problem', 'problem-solving', 'exploration', 'must', 2,
    'Present a vague user complaint, e.g. "Power users say the app feels slow." Ask how they would scope the problem — what they would measure, who they would talk to first, what hypotheses they would rule out before committing to a fix. Look for a structured approach that separates discovery from solutioning.',
    'Probe "What if the instrumentation to measure this doesn\'t exist yet — what do you do in week one?" and "You have two weeks, not two months — what changes about your scope?"',
    'Mid-level PMs own scoping end-to-end; seniors delegate it — this question calibrates where the candidate actually sits.'],
  ['experiment-design', 'Rigorous experiment design', 'experimentation', 'exploration', 'if-time', 2,
    'Ask to design an A/B test. Expect statistical significance, MDE, randomization, duration, interaction effects.',
    'Probe "Experiment ran 2 weeks. Long enough? Why?" and novelty effects.'],
  ['funnel-at-scale', 'Funnel decomposition at scale', 'analytical', 'exploration', 'if-time', 2,
    'Present MAU drop. Expect segmentation (new vs returning, geo, platform, cohort).',
    'Probe mix-shift analysis and Simpson\'s paradox awareness.'],
  ['engineering-tradeoffs', 'Engineering tradeoff conversations', 'technical-literacy', 'exploration', 'if-time', 2,
    'Present latency tradeoff. Look for data-driven architecture reasoning.',
    'Probe "Option A: 2 weeks. Option B: 8 weeks but better. What do you do?"'],
  ['instrumentation', 'Instrumentation and logging strategy', 'data-driven', 'exploration', 'if-time', 2,
    'Ask what events to log for a new feature. Look for proactive event taxonomy.',
    'Probe privacy considerations and property selection.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['growth-modeling', 'Growth and retention modeling', 'data-driven', 'closing', 'must', 0,
    'Ask about long-term retention vs short-term engagement. Assess cohort thinking.',
    'Surface — activation vs habit formation distinction.'],
]

const senior: CompactSlot[] = [
  ['metrics-architecture', 'Metrics architecture for a product area', 'data-driven', 'warm-up', 'must', 0,
    'Ask "5 teams, no shared metrics framework. Design one." Hierarchy, cascading from OKRs.',
    'Surface — calibrate systems-level metrics thinking.', 'Designing systems, not solving instances.'],
  ['experimentation-program', 'Experimentation program design', 'experimentation', 'exploration', 'must', 2,
    'Ask about fixing an org running 200 untrusted experiments. Governance, interaction effects, holdouts.',
    'Probe "Two PMs designed conflicting experiments. Resolve."'],
  ['tech-roadmap-influence', 'Technical roadmap and architecture influence', 'technical-literacy', 'exploration', 'must', 2,
    'Present "Monolith causing reliability issues, eng wants 6-month rewrite. Evaluate." THE signature question.',
    'Probe quantifying tech debt impact, incremental vs big-bang, framing for exec buy-in.',
    'Expected to have experience-formed opinions and defend them.'],
  ['causal-inference', 'Causal inference beyond A/B', 'experimentation', 'exploration', 'must', 2,
    'Ask about evaluating impact when A/B testing isn\'t possible. Diff-in-diff, synthetic controls.',
    'Probe when each method is appropriate and limitations.'],
  ['ml-ai-decisions', 'ML/AI product decisions', 'technical-literacy', 'exploration', 'if-time', 2,
    'Ask questions before greenlighting ML recommendations. Training data, cold-start, bias, build vs buy.',
    'Probe failure modes and success metrics for ML products.'],
  ['privacy-measurement', 'Privacy and measurement constraints', 'data-driven', 'exploration', 'if-time', 2,
    'GDPR/ATT broke core measurement. Now what? Differential privacy, aggregated reporting.',
    'Probe regulatory adaptation and cohort-based analysis.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['data-alignment', 'Cross-functional data alignment', 'leadership', 'closing', 'must', 0,
    'Ask about resolving teams reporting different numbers. Metric governance, canonical definitions.',
    'Surface — assess org politics around data.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('pm', 'technical', '0-2', entry, [
    'Naming metrics without explaining why',
    'Single estimation number without decomposition',
    'Treating A/B testing as magic',
    'Over-jargoning instead of explaining simply',
  ]),
  template('pm', 'technical', '3-6', mid, [
    'A/B test without sample size or duration',
    'All metrics equally important — no hierarchy',
    'Looking at aggregates only when diagnosing',
    'Over-deferring to engineering',
    'Ignoring guardrail metrics',
  ]),
  template('pm', 'technical', '7+', senior, [
    'Solving instance instead of designing system',
    'Not addressing organizational dynamics',
    'Over-relying on A/B testing as universal answer',
    'No point of view on build vs buy for data infra',
    'Solutions that don\'t scale across teams',
  ]),
]
