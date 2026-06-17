import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Finance × Case Study × 0-2 ─────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['case-intro-structure', 'Problem intro and structuring', 'problem-solving', 'warm-up', 'must', 0,
    'Present a contained finance case (equity vs debt, P&L margin analysis). Assess whether they structure before diving in.',
    'Surface — note how they frame the analysis.', 'Guidance through the data is expected at this level.'],
  ['valuation-attempt', 'A structured valuation or analysis', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to work the numbers toward an answer. Look for logical steps and stated assumptions.',
    'Probe which assumptions matter most and why.'],
  ['recommendation-assumptions', 'Recommendation with stated assumptions', 'financial-acumen', 'exploration', 'must', 2,
    'Ask for a clear recommendation and the assumptions behind it. Look for a defensible conclusion.',
    'Probe what would change their answer.',
    'A clear, assumption-stated recommendation beats a hedged non-answer.'],
  ['key-value-drivers', 'Identifying the key value drivers', 'financial-acumen', 'exploration', 'must', 2,
    'Ask which one or two numbers drive the outcome most. Look for prioritization over computing everything.',
    'Probe why those drivers and what they\'d double-check before committing.',
    'Prioritizing the few drivers that matter is the signal — not exhaustive math.'],
  ['basic-risk', 'Basic risk and downside awareness', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask what could go wrong with their recommendation. Look for downside awareness even if incomplete.',
    'Probe one key risk and a simple mitigation.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['case-reflection', 'What you\'d analyze further with more data', 'problem-solving', 'closing', 'must', 0,
    'Ask what additional data they\'d want and why. Assess awareness of analytical gaps.',
    'Surface — wrap up.'],
]

// ─── Finance × Case Study × 3-6 ─────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['case-scoping', 'Case scoping and data requests', 'problem-solving', 'warm-up', 'must', 0,
    'Present a real case (M&A evaluation, capital allocation). Expect them to scope and request the right data.',
    'Surface — less hand-holding; engineering of the analysis is the signal.', 'Identifying needed data is part of the answer.'],
  ['ma-evaluation', 'Evaluating an acquisition', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to evaluate acquiring a target at a given multiple. Look for synergy and valuation reasoning.',
    'Probe how they estimate synergies and what price discipline they\'d hold.',
    'Should pressure-test the deal, not just justify it.'],
  ['multi-approach-valuation', 'Multiple valuation approaches with sensitivity', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to triangulate value across methods. Look for reconciling differences and a defensible range.',
    'Probe the swing variables and how they\'d present the range.'],
  ['capital-allocation-design', 'Designing a capital-allocation strategy', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to allocate a pool of free cash flow. Look for tradeoffs across reinvestment, return, and risk.',
    'Probe how they balance stakeholders and time horizon.'],
  ['risk-identification', 'Identifying and handling key risks', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask what risks could break the thesis. Look for structured downside analysis.',
    'Probe how they\'d mitigate the biggest one.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['defended-recommendation', 'Your defended recommendation', 'communication', 'closing', 'must', 0,
    'Ask for a crisp recommendation they can defend. Assess conviction backed by analysis.',
    'Surface — wrap up.'],
]

// ─── Finance × Case Study × 7+ ──────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['ambiguous-case-scoping', 'Ambiguous case — candidate drives scope', 'problem-solving', 'warm-up', 'must', 0,
    'Present a broad, ambiguous case (turnaround, dual-track strategy). Candidate must drive the framing.',
    'Surface — note the quality of the framing.', 'Candidate must lead the analysis, not wait for prompts.'],
  ['turnaround-restructuring', 'Designing a turnaround / restructuring plan', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to design a financial turnaround for an underperformer. Look for cash-flow prioritization.',
    'Probe the sequence of moves and what they protect first.',
    'Should confront hard tradeoffs under cash constraints.'],
  ['multi-scenario-analysis', 'Multi-scenario strategic analysis', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to analyze under multiple scenarios (e.g. dual-track IPO/M&A). Look for optionality management.',
    'Probe how they preserve flexibility while committing resources.'],
  ['deal-structuring', 'Creative deal structuring', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they\'d structure a complex deal to manage risk and incentives. Look for creativity grounded in numbers.',
    'Probe how the structure shifts risk between parties.'],
  ['risk-mitigation-strategy', 'Executive risk-mitigation strategy', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask how they\'d mitigate the key risks of their plan. Look for a concrete, prioritized strategy.',
    'Probe what they\'d monitor and what would trigger a change.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['executive-recommendation', 'Executive-ready recommendation', 'communication', 'closing', 'must', 0,
    'Ask for a board-ready recommendation with risks and mitigations. Assess executive judgment.',
    'Surface — assess strategic clarity.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('finance', 'case-study', '0-2', entry, [
    'Turnaround, restructuring, or dual-track strategy',
    'Creative deal structuring',
    'Penalizing for needing guidance through the data',
    'Generic business-strategy cases with no financial data',
  ]),
  template('finance', 'case-study', '3-6', mid, [
    'Single-step analysis with no sensitivity or range',
    'Executive turnaround/restructuring (senior territory)',
    'Recommendations with no quantitative support',
    'Ignoring downside scenarios',
  ]),
  template('finance', 'case-study', '7+', senior, [
    'Hand-holding through the case structure',
    'Single-scenario analysis with no optionality',
    'Recommendations that ignore risk and execution',
    'Textbook cases with no ambiguity or tradeoffs',
  ]),
]
