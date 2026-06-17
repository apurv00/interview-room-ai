import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── Marketing × Technical × 0-2 ────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['analytics-calibration', 'Marketing analytics you\'ve used', 'technical-depth', 'warm-up', 'must', 0,
    'Ask what analytics and metrics they\'ve actually worked with. Calibrate hands-on exposure.',
    'Surface — use to choose which fundamentals to probe.', 'Coursework and internship tools are valid context.'],
  ['attribution-basics', 'Attribution across multiple channels', 'analytical', 'exploration', 'must', 2,
    'Ask how they\'d attribute a conversion that touched several channels. Look for awareness that it\'s hard.',
    'Probe first-touch vs last-touch and why neither is fully right.'],
  ['funnel-analysis', 'Finding the biggest funnel drop-off', 'analytical', 'exploration', 'must', 2,
    'Ask how they\'d analyze a funnel to find where users fall off. Look for a structured, metric-driven approach.',
    'Probe what they\'d do once they found the drop-off.'],
  ['cac-ltv-fundamentals', 'CAC, LTV, and unit economics', 'analytical', 'exploration', 'must', 2,
    'Ask how they think about CAC and LTV. Look for understanding the ratio, not just the definitions.',
    'Probe what a healthy LTV:CAC looks like and why.'],
  ['seo-sem-basics', 'SEO/SEM fundamentals', 'strategy', 'exploration', 'if-time', 1,
    'Ask the basics of organic vs paid search and when to use each. Look for practical understanding.',
    'Probe how they\'d measure whether SEM is working.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['learning-analytics', 'How you build analytics skills', 'problem-solving', 'closing', 'must', 0,
    'Ask how they get up to speed on a new analytics tool or method. Assess learning approach.',
    'Surface — wrap up.'],
]

// ─── Marketing × Technical × 3-6 ────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['analytics-ownership', 'Marketing analytics you own', 'technical-depth', 'warm-up', 'must', 0,
    'Ask what analytics and experiments they own. Calibrate real hands-on depth.',
    'Surface — choose deep-dives.', 'Must be real work tied to revenue, not classroom metrics.'],
  ['growth-modeling', 'Building a growth model', 'analytical', 'exploration', 'must', 2,
    'Ask how they\'d build a growth model for a B2B SaaS product. Look for driver-based reasoning.',
    'Probe the key assumptions and which lever they\'d pull first.',
    'Should connect the model to real channels and economics.'],
  ['experimentation', 'Designing experiments with controls', 'experimentation', 'exploration', 'must', 2,
    'Ask how they design a marketing experiment properly. Look for control groups and statistical rigor.',
    'Probe sample size, significance, and avoiding false positives.'],
  ['attribution-modeling', 'Attribution modeling in practice', 'analytical', 'exploration', 'must', 2,
    'Ask their approach to multi-channel attribution. Look for pragmatic handling of an unsolvable-perfectly problem.',
    'Probe the model they\'d choose and its blind spots.'],
  ['martech-stack', 'Hands-on martech stack', 'technical-literacy', 'exploration', 'if-time', 2,
    'Ask about the martech tools they\'ve operated and integrated. Look for practical workflow knowledge.',
    'Probe a data-quality or integration problem they solved.'],
  ['cac-optimization', 'Optimizing CAC across channels', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they\'d reallocate spend across channels to lower blended CAC. Look for marginal thinking.',
    'Probe how they\'d know a channel was saturating.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['metrics-to-revenue', 'Connecting a marketing metric to revenue', 'technical-depth', 'closing', 'must', 0,
    'Ask them to tie a marketing metric they moved to a business outcome. Assess business connection.',
    'Surface — wrap up.'],
]

// ─── Marketing × Technical × 7+ ─────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['analytics-strategy', 'Analytics and growth strategy', 'technical-depth', 'warm-up', 'must', 0,
    'Ask how they think about marketing analytics at an organizational level. Calibrate scope.',
    'Surface — identify which dimensions to probe.', 'Must show building analytics capability, not running reports.'],
  ['martech-architecture', 'Architecting a martech stack at scale', 'technical-breadth', 'exploration', 'must', 2,
    'Ask how they\'d architect a martech stack for a company spending $10M+/year. Look for integration strategy.',
    'Probe data flow, identity resolution, and the build-vs-buy calls.'],
  ['brand-measurement', 'Measuring brand / incrementality', 'analytical', 'exploration', 'must', 2,
    'Ask their framework for measuring the incremental impact of brand marketing. Look for honest methodology.',
    'Probe how they isolate brand effect from everything else (holdouts, geo tests).',
    'Confronting the measurement difficulty honestly is the signal.'],
  ['multi-touch-attribution', 'Multi-touch attribution at scale', 'analytical', 'exploration', 'must', 2,
    'Ask how they\'d build trustworthy multi-touch attribution org-wide. Look for pragmatism over false precision.',
    'Probe how they\'d get the org to act on it.'],
  ['growth-strategy', 'Analytics-driven growth strategy', 'analytical', 'exploration', 'if-time', 2,
    'Ask how they set growth strategy from data. Look for connecting models to resource allocation.',
    'Probe how they\'d rebalance the portfolio of channels and bets.'],
  ['analytics-org', 'Building an analytics-driven marketing org', 'leadership', 'exploration', 'if-time', 2,
    'Ask how they build a culture and capability of measurement. Look for systems and standards.',
    'Probe how they keep teams honest about what works.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['measurement-bet', 'A measurement approach you\'d revisit', 'self-awareness', 'closing', 'must', 0,
    'Ask about an analytics or attribution approach they\'d now reconsider. Assess intellectual honesty.',
    'Surface — wrap up.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('marketing', 'technical', '0-2', entry, [
    'Org-wide martech architecture or brand incrementality',
    'Building analytics organizations',
    'Behavioral or campaign-story questions',
    'Penalizing for reasoning through fundamentals',
  ]),
  template('marketing', 'technical', '3-6', mid, [
    'Entry-level "what is CAC" fundamentals',
    'Executive martech architecture (senior territory)',
    'Vanity metrics with no connection to revenue',
    'Pure tool trivia without methodology',
  ]),
  template('marketing', 'technical', '7+', senior, [
    'Hands-on tool how-to questions',
    'Single-metric analysis an analyst would do',
    'Claiming precise attribution with no acknowledged blind spots',
    'Methodology with no path to organizational adoption',
  ]),
]
