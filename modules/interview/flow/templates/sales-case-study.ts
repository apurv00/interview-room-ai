import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Sales × Case Study × 0-2 ───────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['case-intro-structure', 'Problem intro and structuring', 'problem-solving', 'warm-up', 'must', 0,
    'Present a contained sales case (first-year plan for a new product, a target account to land). Assess whether they structure before diving in.',
    'Surface — note how they frame the plan.', 'Guidance through the scenario is expected at this level.'],
  ['gtm-plan', 'Building a first-year sales plan', 'strategy', 'exploration', 'must', 2,
    'Ask them to build a first-year plan for a new product with no customer base. Look for target accounts, outreach, and pipeline targets.',
    'Probe their prospecting strategy and how they\'d generate the first deals.',
    'A clear, sequenced plan beats a long list of tactics.'],
  ['target-account-strategy', 'Landing a marquee account', 'strategy', 'exploration', 'must', 2,
    'Ask them to design a strategy to land a Fortune 500 logo. Look for stakeholder engagement and a way in.',
    'Probe who they\'d target first and how they\'d earn the first meeting.'],
  ['activity-to-pipeline', 'Connecting activity to pipeline', 'strategy', 'exploration', 'must', 2,
    'Ask how their activity translates into pipeline and revenue. Look for basic activity math, even if rough.',
    'Probe the conversion assumptions from outreach to meeting to deal.',
    'Reasonable activity math matters more than precision here.'],
  ['basic-competitive', 'Positioning against a competitor', 'strategy', 'exploration', 'if-time', 2,
    'Ask how they\'d position when a prospect is considering a competitor. Look for value framing over price-matching.',
    'Probe one differentiator and how they\'d make it land.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['case-reflection', 'What you\'d firm up with more information', 'problem-solving', 'closing', 'must', 0,
    'Ask what they\'d want to learn about the market or product before committing. Assess awareness of gaps.',
    'Surface — wrap up.'],
]

// ─── Sales × Case Study × 3-6 ───────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['case-scoping', 'Case scoping and constraints', 'problem-solving', 'warm-up', 'must', 0,
    'Present a real case (region at 60% of quota, a price-undercutting competitor). Expect them to scope and ask the right questions.',
    'Surface — less hand-holding; structuring the recovery is the signal.', 'Identifying the constraints and quota math is part of the answer.'],
  ['quota-recovery', 'Recovering a region behind quota', 'execution', 'exploration', 'must', 2,
    'Ask for a recovery plan for a region at 60% of quota mid-year. Look for activity math and prioritization.',
    'Probe the pipeline coverage needed and where they\'d focus first.',
    'Should connect the gap to concrete pipeline and activity, not just effort.'],
  ['competitive-response', 'Responding to a pricing attack', 'strategy', 'exploration', 'must', 2,
    'Ask them to respond to a competitor undercutting price by 40%. Look for value differentiation over a price war.',
    'Probe how they\'d reframe the conversation away from price.'],
  ['account-plan', 'Building an enterprise account plan', 'strategy', 'exploration', 'must', 2,
    'Ask them to build a plan to expand within a key account. Look for stakeholder mapping and a land-and-expand path.',
    'Probe how they\'d sequence the expansion and de-risk it.'],
  ['resource-allocation', 'Allocating limited selling time', 'execution', 'exploration', 'if-time', 2,
    'Ask how they\'d allocate limited time across many accounts. Look for ruthless prioritization toward revenue.',
    'Probe how they decide what not to work.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['defended-plan', 'Your defended sales plan', 'communication', 'closing', 'must', 0,
    'Ask for a crisp plan they can defend with pipeline math. Assess conviction backed by numbers.',
    'Surface — wrap up.'],
]

// ─── Sales × Case Study × 7+ ────────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['ambiguous-case-scoping', 'Ambiguous case — candidate drives scope', 'problem-solving', 'warm-up', 'must', 0,
    'Present a broad case (enterprise market entry against an incumbent, a partner channel build). Candidate must drive the framing.',
    'Surface — note the quality of the strategy framing.', 'Candidate must lead the strategy, not wait for prompts.'],
  ['market-entry', 'Entering a market owned by an incumbent', 'strategy', 'exploration', 'must', 2,
    'Ask them to design a GTM strategy to enter an enterprise market dominated by an incumbent. Look for competitive displacement thinking.',
    'Probe the wedge they\'d use and how they\'d win the first reference accounts.',
    'Should confront the incumbent advantage head-on, not ignore it.'],
  ['channel-program', 'Building a partner channel program', 'strategy', 'exploration', 'must', 2,
    'Ask them to build a partner channel generating 30% of revenue in 18 months. Look for partner economics.',
    'Probe how they\'d recruit, enable, and avoid channel conflict.'],
  ['multi-channel-gtm', 'Designing a multi-channel GTM', 'strategy', 'exploration', 'must', 2,
    'Ask them to combine direct, channel, and self-serve motions for a revenue target. Look for coherent multi-channel design.',
    'Probe how the channels reinforce rather than cannibalize each other.'],
  ['revenue-modeling', 'Modeling the revenue path', 'strategy', 'exploration', 'if-time', 2,
    'Ask them to model the path from headcount and pipeline to the revenue target. Look for a defensible revenue model.',
    'Probe the assumptions that most threaten the plan.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['executive-recommendation', 'Executive-ready sales strategy', 'communication', 'closing', 'must', 0,
    'Ask for a board-ready strategy with revenue model and risks. Assess strategic judgment.',
    'Surface — assess strategic clarity.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('sales', 'case-study', '0-2', entry, [
    'Enterprise market entry, channel programs, or multi-channel GTM',
    'Detailed revenue modeling across headcount and channels',
    'Penalizing for needing guidance through the scenario',
    'Abstract business-strategy cases with no quota or pipeline',
  ]),
  template('sales', 'case-study', '3-6', mid, [
    'A plan with no activity math or pipeline coverage',
    'Org-level market entry or channel design (senior territory)',
    'Recommendations with no connection to revenue targets',
    'Ignoring competitive dynamics in the plan',
  ]),
  template('sales', 'case-study', '7+', senior, [
    'Hand-holding through the case structure',
    'Single-channel plans with no GTM design',
    'Strategies that ignore competitive displacement or partner economics',
    'Abstract cases with no revenue model or quota math',
  ]),
]
