import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Sales × Technical × 0-2 ────────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['sales-process-calibration', 'Sales process you\'ve actually run', 'technical-depth', 'warm-up', 'must', 0,
    'Ask what parts of the sales process they\'ve actually owned. Calibrate hands-on exposure vs training.',
    'Surface — use to choose which fundamentals to probe.', 'Internship, SDR, and early-rep experience are valid context.'],
  ['deal-qualification', 'Qualifying a deal', 'execution', 'exploration', 'must', 2,
    'Ask how they qualify a deal using their preferred methodology. Look for clear criteria, including when to disqualify.',
    'Probe what makes them walk away from a deal early.',
    'One methodology applied cleanly matters more than naming several.'],
  ['crm-discipline', 'Managing pipeline in the CRM', 'operational', 'exploration', 'must', 2,
    'Ask how they use the CRM to manage pipeline and stay organized. Look for data hygiene and discipline.',
    'Probe how they keep stages and next-steps accurate.'],
  ['discovery-questions', 'Running an effective discovery call', 'technical-depth', 'exploration', 'must', 2,
    'Ask how they uncover a prospect\'s real needs. Look for structured questioning over feature-dumping.',
    'Probe how they separate stated wants from underlying pain.'],
  ['simple-forecasting', 'Knowing what will close', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they decide which deals to commit to a forecast. Look for stage-based reasoning over hope.',
    'Probe what evidence makes them confident a deal will close.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['learning-sales-craft', 'How you sharpen your sales skills', 'problem-solving', 'closing', 'must', 0,
    'Ask how they get better at selling and learn a new product or market. Assess learning approach.',
    'Surface — wrap up.'],
]

// ─── Sales × Technical × 3-6 ────────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['methodology-experience', 'Methodologies you run day-to-day', 'technical-depth', 'warm-up', 'must', 0,
    'Ask which methodologies they actually use and how. Calibrate real fluency vs vocabulary.',
    'Surface — choose deep-dives.', 'Must be lived practice, not certification recall.'],
  ['meddic-vs-challenger', 'Comparing MEDDIC and Challenger', 'technical-depth', 'exploration', 'must', 2,
    'Ask them to compare MEDDIC and Challenger and when to use each. Look for practical, situation-aware judgment.',
    'Probe a concrete deal where the choice of approach mattered.',
    'Should reason about fit to the deal, not recite framework steps.'],
  ['reliable-forecast', 'Building a forecast leadership can trust', 'analytical', 'exploration', 'must', 2,
    'Ask how they build a pipeline forecast leadership can rely on. Look for an accuracy methodology, not gut feel.',
    'Probe how they handle sandbagging, slipped deals, and stage inflation.'],
  ['deal-qualification-rigor', 'Rigorous deal qualification', 'execution', 'exploration', 'must', 2,
    'Ask how they decide which deals deserve their time. Look for disqualification discipline.',
    'Probe the signals that make them deprioritize or kill a deal.'],
  ['pipeline-analytics', 'Reading pipeline health metrics', 'analytical', 'exploration', 'if-time', 2,
    'Ask which metrics tell them their pipeline is healthy. Look for coverage, velocity, and conversion thinking.',
    'Probe what they do when a stage conversion rate drops.'],
  ['negotiation-framework', 'Negotiating and protecting value', 'technical-depth', 'exploration', 'if-time', 2,
    'Ask how they negotiate without caving on price. Look for trading concessions and protecting margin.',
    'Probe how they handle a late-stage discount demand.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['methodology-judgment', 'A qualification call you\'d defend or revisit', 'technical-depth', 'closing', 'must', 0,
    'Ask about a qualification or forecast call they\'d defend or now reconsider. Assess reasoning maturity.',
    'Surface — wrap up.'],
]

// ─── Sales × Technical × 7+ ─────────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['revenue-systems-philosophy', 'Revenue and sales-systems philosophy', 'technical-depth', 'warm-up', 'must', 0,
    'Ask how they think about sales process, territory, and comp as a system. Calibrate strategic scope.',
    'Surface — identify which dimensions to probe.', 'Must show systems-level, not just rep-level, judgment.'],
  ['territory-comp-design', 'Designing territory and comp for a new market', 'operational', 'exploration', 'must', 2,
    'Ask how they\'d design a territory and compensation plan for a new market. Look for incentive alignment.',
    'Probe how the comp plan drives the behavior they want and where it could backfire.',
    'Should reason about coverage, fairness, and unintended incentives.'],
  ['enablement-program', 'Building a sales enablement program', 'execution', 'exploration', 'must', 2,
    'Ask how they\'d build sales enablement from scratch. Look for onboarding, ramp, and measurement.',
    'Probe how they\'d measure whether enablement actually moved win rates.'],
  ['forecasting-at-scale', 'Forecasting across a sales org', 'analytical', 'exploration', 'must', 2,
    'Ask how they roll up and pressure-test a forecast across multiple teams. Look for accuracy discipline at scale.',
    'Probe how they reconcile bottoms-up rep calls with top-down reality.'],
  ['win-loss-program', 'Win/loss analytics that change behavior', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they build a win/loss program that improves conversion. Look for actionable, structural changes.',
    'Probe a specific change a win/loss insight drove in their org.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['developing-rep-skill', 'Building methodology fluency in a team', 'leadership', 'closing', 'must', 0,
    'Ask how they build qualification and forecasting discipline across a team. Assess standards and coaching.',
    'Surface — wrap up.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('sales', 'technical', '0-2', entry, [
    'Designing territory or compensation plans',
    'Building enablement programs at the org level',
    'Behavioral or situational questions',
    'Penalizing for needing to reason through a methodology from scratch',
  ]),
  template('sales', 'technical', '3-6', mid, [
    'Entry-level "what is MEDDIC" definitions',
    'Org-wide comp and territory design (senior territory)',
    'Accepting gut-feel forecasting with no accuracy methodology',
    'Pure framework recall without applied judgment',
  ]),
  template('sales', 'technical', '7+', senior, [
    'Mechanical "how do you qualify a deal" basics a rep answers',
    'Single-methodology recitation with no systems thinking',
    'Ignoring incentive design and forecast accuracy at scale',
    'Tactical rep questions with no org-level scope',
  ]),
]
