import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Finance × Technical × 0-2 ──────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['finance-fundamentals-calibration', 'Financial fundamentals you\'ve used', 'technical-depth', 'warm-up', 'must', 0,
    'Ask what financial analysis they\'ve actually done. Calibrate hands-on exposure vs coursework.',
    'Surface — use to choose which fundamentals to probe.', 'Coursework and internship work are valid context.'],
  ['read-financial-statements', 'Reading financial statements', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they\'d assess a company\'s health from its statements. Look for linking the three statements.',
    'Probe what they look at first and why (cash flow vs earnings).'],
  ['dcf-concepts', 'Valuing a company (DCF concepts)', 'financial-acumen', 'exploration', 'must', 2,
    'Ask them to walk through valuing a company. Look for understanding of cash flows, discount rate, and terminal value.',
    'Probe why they chose a method and what drives the answer.',
    'Conceptual clarity matters more than model complexity here.'],
  ['comparable-analysis', 'Comparable / multiples analysis', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they\'d use comparables to value a company. Look for choosing the right peers and multiples.',
    'Probe why a multiple differs across companies.'],
  ['debt-capacity', 'Assessing debt capacity', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask how they\'d judge whether a company can take on more debt. Look for the right ratios and reasoning.',
    'Probe which metrics and what thresholds.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['learning-finance', 'How you build financial skills', 'problem-solving', 'closing', 'must', 0,
    'Ask how they get up to speed on a new financial concept or industry. Assess learning approach.',
    'Surface — wrap up.'],
]

// ─── Finance × Technical × 3-6 ──────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['modeling-experience', 'Financial modeling you own', 'technical-depth', 'warm-up', 'must', 0,
    'Ask what models and analyses they own in their work. Calibrate real deal/analysis experience.',
    'Surface — choose deep-dives.', 'Must be real work, not classroom models.'],
  ['dcf-modeling', 'Building a DCF model', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they build and pressure-test a DCF. Look for driver-based assumptions and discipline.',
    'Probe the assumptions that move the answer most and how they sanity-check it.',
    'Should reason about drivers, not just mechanics.'],
  ['acquisition-model', 'Modeling an acquisition target', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they\'d model an acquisition. Look for synergy treatment and key assumptions.',
    'Probe sensitivity to the key assumptions and how they\'d present the range.'],
  ['forecasting', 'Building a multi-year forecast', 'analytical', 'exploration', 'must', 2,
    'Ask how they build a three-year forecast for a high-growth company. Look for a driver-based approach.',
    'Probe how they handle uncertainty and tie it to operational drivers.'],
  ['lbo-basics', 'LBO mechanics', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask how an LBO creates returns. Look for understanding of leverage, cash generation, and exit.',
    'Probe what drives the return and the main risks.'],
  ['sensitivity-analysis', 'Sensitivity and scenario analysis', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask how they present a range rather than a single number. Look for identifying the swing variables.',
    'Probe how they\'d communicate the uncertainty to a decision-maker.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['modeling-judgment', 'An assumption you\'d defend or revisit', 'technical-depth', 'closing', 'must', 0,
    'Ask about a modeling judgment call they\'d defend or now reconsider. Assess reasoning maturity.',
    'Surface — wrap up.'],
]

// ─── Finance × Technical × 7+ ───────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['valuation-philosophy', 'Valuation and capital philosophy', 'technical-depth', 'warm-up', 'must', 0,
    'Ask how they think about valuation and capital decisions at a strategic level. Calibrate scope.',
    'Surface — identify which dimensions to probe.', 'Must show strategic, not just technical, judgment.'],
  ['complex-valuation', 'Complex valuation methodology', 'financial-acumen', 'exploration', 'must', 2,
    'Ask about valuing something hard (optionality, distressed, multi-business). Look for methodology judgment.',
    'Probe how they reconcile methods that disagree.',
    'Should handle ambiguity, not just textbook cases.'],
  ['capital-allocation', 'Capital-allocation framework', 'financial-acumen', 'exploration', 'must', 2,
    'Ask their framework for allocating capital across competing uses. Look for risk-adjusted return thinking.',
    'Probe how they weigh buybacks vs reinvestment vs M&A.'],
  ['capital-structure', 'Capital structure for an IPO or major event', 'financial-acumen', 'exploration', 'must', 2,
    'Ask how they think about optimal capital structure approaching an IPO. Look for market-aware judgment.',
    'Probe how market conditions change the answer.'],
  ['risk-frameworks', 'Risk-assessment frameworks at scale', 'financial-acumen', 'exploration', 'if-time', 2,
    'Ask how they build risk assessment into financial decisions. Look for structured downside thinking.',
    'Probe how they quantify and mitigate tail risk.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['mentoring-analysts', 'Developing financial judgment in others', 'leadership', 'closing', 'must', 0,
    'Ask how they build modeling and judgment in their team. Assess mentoring and standards.',
    'Surface — wrap up.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('finance', 'technical', '0-2', entry, [
    'Complex LBO, distressed, or optionality valuation',
    'Capital-allocation frameworks at the executive level',
    'Behavioral or situational questions',
    'Penalizing for needing to reason through fundamentals',
  ]),
  template('finance', 'technical', '3-6', mid, [
    'Entry-level "what is a DCF" fundamentals',
    'Executive capital-structure strategy (senior territory)',
    'Accepting single-point estimates with no sensitivity',
    'Pure formula recall without reasoning',
  ]),
  template('finance', 'technical', '7+', senior, [
    'Mechanical modeling questions an analyst answers',
    'Single-method valuation with no judgment',
    'Ignoring risk or downside scenarios',
    'Textbook cases with no ambiguity',
  ]),
]
