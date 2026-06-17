import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Marketing × Case Study × 0-2 ───────────────────────────────────────────
const entry: CompactSlot[] = [
  ['case-intro-structure', 'Problem intro and structuring', 'problem-solving', 'warm-up', 'must', 0,
    'Present a contained case (launch a small DTC brand, content plan for a B2B audience). Assess structuring.',
    'Surface — note how they frame audience, channels, message.', 'Guidance through the brief is expected at this level.'],
  ['audience-messaging', 'Audience definition and messaging', 'strategy', 'exploration', 'must', 2,
    'Ask who the target is and what the message should be. Look for a specific audience, not "everyone".',
    'Probe why this audience and how the message fits them.'],
  ['channel-selection', 'Channel selection rationale', 'strategy', 'exploration', 'must', 2,
    'Ask which channels they\'d use and why. Look for rationale tied to the audience and budget.',
    'Probe the tradeoff between a couple of channels they considered.',
    'A defended channel choice beats a long undifferentiated list.'],
  ['measurement-awareness', 'How you\'d measure success', 'analytical', 'exploration', 'must', 2,
    'Ask what metrics tell them the plan is working. Look for outcome metrics, not just activity.',
    'Probe what they\'d do if the leading metric looked bad early.'],
  ['budget-basics', 'Allocating a limited budget', 'strategic-thinking', 'exploration', 'if-time', 2,
    'Ask how they\'d split a limited budget across their chosen channels. Look for prioritization over spreading thin.',
    'Probe what they\'d fund first and why.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['case-reflection', 'What you\'d test or learn first', 'problem-solving', 'closing', 'must', 0,
    'Ask what they\'d validate before committing the full budget. Assess test-and-learn instinct.',
    'Surface — wrap up.'],
]

// ─── Marketing × Case Study × 3-6 ───────────────────────────────────────────
const mid: CompactSlot[] = [
  ['gtm-scoping', 'GTM scoping and constraints', 'strategy', 'warm-up', 'must', 0,
    'Present a real GTM case (PLG→enterprise shift, competitive threat) with a budget. Expect proactive scoping.',
    'Surface — less hand-holding; strategic structuring is the signal.', 'Budget and constraints are part of the problem.'],
  ['gtm-plan', 'Building the GTM plan', 'strategy', 'exploration', 'must', 2,
    'Ask for the go-to-market plan. Look for audience, positioning, channels, and sequencing.',
    'Probe how the plan changes for the new motion (e.g. enterprise vs PLG).',
    'Should connect tactics to the strategic shift.'],
  ['budget-allocation', 'Budget allocation across channels', 'strategic-thinking', 'exploration', 'must', 2,
    'Ask how they\'d split the budget. Look for rationale and a willingness to concentrate, not spread thin.',
    'Probe what they\'d cut first if the budget dropped 20%.'],
  ['competitive-response', 'Responding to a stronger competitor', 'strategy', 'exploration', 'must', 2,
    'Ask how they\'d compete against a rival with 3x the budget. Look for asymmetric strategy.',
    'Probe where they\'d avoid a head-to-head fight and where they\'d differentiate.'],
  ['measurement-framework', 'Measurement framework', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they\'d measure the plan end-to-end. Look for leading and lagging indicators.',
    'Probe attribution approach and what would make them change course.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['defended-strategy', 'Your defended GTM recommendation', 'communication', 'closing', 'must', 0,
    'Ask for a crisp recommendation they can defend. Assess conviction backed by rationale.',
    'Surface — wrap up.'],
]

// ─── Marketing × Case Study × 7+ ────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['ambiguous-case-scoping', 'Ambiguous strategy case — candidate drives', 'problem-solving', 'warm-up', 'must', 0,
    'Present a broad case (global expansion, 30% budget cut without losing revenue). Candidate drives scope.',
    'Surface — note the quality of the framing.', 'Candidate must lead the strategy, not wait for prompts.'],
  ['global-strategy', 'Global / multi-market strategy', 'strategy', 'exploration', 'must', 2,
    'Ask for a strategy to expand a brand into several new markets. Look for localization-vs-standardization judgment.',
    'Probe what stays global and what must be local, and why.'],
  ['budget-cut-strategy', 'Cutting spend without losing revenue', 'strategic-thinking', 'exploration', 'must', 2,
    'Ask how they\'d cut marketing spend 30% without losing revenue. Look for ruthless prioritization by ROI.',
    'Probe what they protect and how they prove the cuts were safe.',
    'Should confront the hard tradeoffs, not promise no pain.'],
  ['competitive-positioning', 'Competitive positioning and differentiation', 'strategy', 'exploration', 'must', 2,
    'Ask how they\'d position the brand against entrenched competitors. Look for a sharp, defensible position.',
    'Probe how the positioning shows up across the funnel.'],
  ['multi-phase-rollout', 'Multi-phase rollout and sequencing', 'strategy', 'exploration', 'if-time', 2,
    'Ask how they\'d phase the strategy over time. Look for sequencing that manages risk and learning.',
    'Probe the gate between phases and what would pause the rollout.'],
  ['integrated-measurement', 'Integrated, board-level measurement', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they\'d measure brand and performance together for the board. Look for an honest, integrated framework.',
    'Probe how they\'d defend brand spend to a skeptical CFO.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['executive-recommendation', 'Executive-ready recommendation', 'communication', 'closing', 'must', 0,
    'Ask for a board-ready recommendation with tradeoffs and risks. Assess executive judgment.',
    'Surface — assess strategic clarity.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('marketing', 'case-study', '0-2', entry, [
    'Global expansion or executive budget strategy',
    'Multi-phase rollout and board-level measurement',
    'Penalizing for needing guidance through the brief',
    'Cases with no audience, channel, or budget specifics',
  ]),
  template('marketing', 'case-study', '3-6', mid, [
    'Single-channel plans with no budget tradeoffs',
    'Global multi-market strategy (senior territory)',
    'Plans with no measurement framework',
    'Ignoring the competitive context',
  ]),
  template('marketing', 'case-study', '7+', senior, [
    'Hand-holding through the case structure',
    'Tactics without strategic positioning',
    'Promising budget cuts with no real tradeoffs',
    'Plans with no integrated brand + performance measurement',
  ]),
]
