/**
 * Role-matched candidate resumes for the QA matrix (one per roster domain).
 *
 * WHY: the matrix authenticates as ONE automation user whose DB profile reads as
 * "PM at a media company". generate-question + the new /api/code|design/
 * generate-problem routes personalize to the candidate's resume, so EVERY cell
 * was skewed toward that PM/media persona (the audit finding). Setting a
 * role-matched resume per cell makes the next run actually measure role+resume
 * personalization instead of the default profile.
 *
 * Each entry is plain resume text (the generators wrap it in <candidate_resume>
 * and slice to ~1200 chars). Keep them role-authentic — the keywords/tools/metrics
 * here are exactly what the generators should latch onto.
 *
 * ─── WIRING (3 edits, then rebuild) ────────────────────────────────────────────
 * 1. modules/qa/runner/bakeRosterIntoRunner.mjs
 *      import { ROSTER_DOMAINS, ROSTER_DEPTHS, SMOKE_CELLS } from '../orchestrator/rosterMatrixData.mjs'
 *    + import { ROSTER_RESUMES } from '../orchestrator/rosterResumes.mjs'
 *    …and inside the baked `// __QA_ROSTER_START__` block, add:
 *    +   const ROSTER_RESUMES = ${JSON.stringify(ROSTER_RESUMES)}
 *
 * 2. modules/qa/browser/qa-matrix-runner.js — at each `const config = { role: domain, … }`
 *    build (runInterview ~L351, coding ~L490, design ~L549), append the resume:
 *      const config = { role: domain, interviewType: depth, experience: '3-6',
 *    -     duration: DURATION, privacyMode: true }
 *    +     duration: DURATION, privacyMode: true, resumeText: ROSTER_RESUMES[domain] || '' }
 *    (ROSTER_RESUMES is in scope because step 1 bakes it into the runner.)
 *    For coding/system-design cells, the runner calls the APIs directly — if you
 *    want those to exercise the new generators, also POST the resume to
 *    /api/code/generate-problem and /api/design/generate-problem
 *    ({ domain, experience, solvedProblemIds, resumeText: ROSTER_RESUMES[domain] }).
 *
 * 3. Rebuild the injected runner:  npm run qa:build:browser
 *    (regenerates modules/qa/browser/inject-chunk-*.txt + inject-manifest.json)
 *
 * Slugs MUST match ROSTER_DOMAINS in rosterMatrixData.mjs.
 */

/** @type {Record<string, string>} */
export const ROSTER_RESUMES = {
  frontend:
    'Senior Frontend Engineer — 6 yrs (React, TypeScript, Next.js).\n' +
    '- Built a component design system adopted across 14 surfaces; component reuse 23% to 78%.\n' +
    '- Cut marketing LCP 4.2s to 1.8s via route code-splitting, next/image, and critical-CSS inlining.\n' +
    '- Owns the accessibility (WCAG AA) workstream; axe-in-CI, focus management, keyboard/SR support.',
  backend:
    'Backend Engineer — 7 yrs (Go, Node, Postgres, Redis, Kafka).\n' +
    '- Designed a sharded URL service at 40M redirects/day, p99 < 12ms (hot-slug Redis cache, async click writes to Kafka).\n' +
    '- Migrated a payments monolith to event-driven services with dual-write + DLQs; p99 800ms to 120ms, zero data loss.\n' +
    '- On-call for the checkout SLA; drove a SEV2 rollback in 14 minutes and added canary releases.',
  sdet:
    'SDET / Test Engineer — 5 yrs (Playwright, Pytest, CI).\n' +
    '- Stabilized a 12%-flaky E2E suite to 1.5% with per-worker DB isolation, deterministic seeds, and infra-only retries.\n' +
    '- Cut suite runtime 38 to 11 minutes via parallel sharding; built a shared test SDK (auth/seeding/artifact fixtures).\n' +
    '- Added contract tests at service boundaries; production escapes down 40%.',
  fullstack:
    'Full-Stack Engineer — 6 yrs (TypeScript, React, Node, Postgres).\n' +
    '- Shipped features end to end: React/Next front end, REST/tRPC APIs, schema design, and caching.\n' +
    '- Built a click-tracking flow front-to-DB that stays fast and accurate under a 100:1 read/write ratio.\n' +
    '- Comfortable across the stack: state management, API contracts, query optimization, and deploys.',
  devops:
    'DevOps / SRE — 7 yrs (Kubernetes, Terraform, GitHub Actions, Prometheus).\n' +
    '- Owns CI/CD with canary + blue-green rollouts; autoscaling via HPA + cluster-autoscaler.\n' +
    '- Defines SLOs and runs error-budget decisions; on-call lead, MTTR 45 to 8 minutes on recent incidents.\n' +
    '- IaC for multi-env infra; observability with OpenTelemetry, structured logs, and runbooks.',
  mobile:
    'Mobile Engineer — 6 yrs (iOS/Swift + SwiftUI, Android/Kotlin + Compose).\n' +
    '- Built offline-first sync with conflict resolution for downloadable content; reconciles iOS vs Android lifecycles.\n' +
    '- Tuned list virtualization, image caching, and jank on mid-range devices; push + deep-link plumbing.\n' +
    '- Ships cross-platform features and owns release trains for both stores.',
  'data-science':
    'Data Scientist — 6 yrs (Python, pandas, scikit-learn, SQL).\n' +
    '- Built classification + ranking models; rigorous train/val/test splits to avoid leakage, calibration over raw AUC.\n' +
    '- Designed pre-registered A/B holdouts with stop rules; shipped a pricing change at 95% CI on +4.2% revenue.\n' +
    '- Partners with engineering on feature pipelines and production monitoring.',
  'ml-engineer':
    'Machine Learning Engineer — 6 yrs (PyTorch, MLflow, Triton, Feast).\n' +
    '- Rebuilt batch serving (6h lag) into near-real-time inference: online/offline feature store, p99 < 80ms at 50k rps.\n' +
    '- Owns training pipelines, model registry, shadow traffic, and drift/decay monitoring with retrain + rollback rules.\n' +
    '- Handles class imbalance, training-serving skew, and metric selection (precision/recall/AUC/calibration).',
  'data-analyst':
    'Data Analyst — 5 yrs (SQL, pandas, dbt, Looker/Tableau).\n' +
    '- Investigates metric movements: decomposes funnels/cohorts, separates tracking artifacts from real engagement.\n' +
    '- Built the metrics layer + dashboards adopted org-wide; wrote the metric dictionary that ended definition disputes.\n' +
    '- Designs and reads experiments; comfortable with window functions, segmentation, and data-quality checks.',
  pm:
    'Product Manager — 7 yrs.\n' +
    '- Fixed onboarding activation (+19% in 4 weeks) via user interviews, prototypes, and a pre-registered 50/50 test.\n' +
    '- Owns roadmap and tradeoffs; cut an enterprise ask to protect a billing deadline while offering a phased path.\n' +
    '- Runs weekly experiment reviews; ties roadmap items to research and metrics.',
  'product-analyst':
    'Product Analyst — 5 yrs (SQL, Amplitude/Mixpanel, A/B testing).\n' +
    '- Owns activation/retention metrics; debugs a 7-day retention drop with cohort cuts and SQL, ruling out instrumentation.\n' +
    '- Defines guardrail metrics and reads experiment results; builds self-serve funnels and tracking plans.\n' +
    '- Translates product questions into instrumented, statistically sound analyses.',
  design:
    'Product Designer — 7 yrs (end-to-end UX: research, IA, prototyping, validation).\n' +
    '- Diagnosed a 60% drop-off flow with unmoderated sessions + affinity mapping; redesign lifted completion 24%.\n' +
    '- Built and evolved a design system/component library; shortened design review cycles 9 days to 3.\n' +
    '- Balances accessibility and visual polish against delivery timelines.',
  'product-designer':
    'Product Designer — 7 yrs (UX research, IA, interaction design, prototyping).\n' +
    '- Leads end-to-end product design: problem framing, journey mapping, hi-fi prototypes, and usability validation.\n' +
    '- Redesigned a subscription paywall and onboarding; partners closely with PM + eng on tradeoffs.\n' +
    '- Runs design critiques and evolves shared patterns across surfaces.',
  'ui-designer':
    'UI / Visual Designer — 6 yrs (Figma, design systems, typography, motion).\n' +
    '- Owns visual craft: type scale, spacing rhythm, color hierarchy, focus states, and responsive breakpoints.\n' +
    '- Built a Figma component library (variants + constraints) for clean developer handoff and scale.\n' +
    '- Unified brand typography across apps; cut design review time 35%.',
  business:
    'Business Analyst / Generalist — 6 yrs.\n' +
    '- Diagnoses ambiguous business problems: segments data, correlates with campaigns, tests falsifiable hypotheses.\n' +
    '- Built a 3-scenario model with sensitivity on churn and ARPU that secured board approval for a pricing change.\n' +
    '- Comfortable translating analysis into stakeholder recommendations.',
  strategy:
    'Strategy Manager — 7 yrs (corporate / product strategy, ex-consulting).\n' +
    '- Defined a defensible mid-market strategy: segmented by willingness-to-pay, doubled down on enterprise depth, sunset a low-margin tier; win rate +28%.\n' +
    '- Built a 3-year platform vision mapping capabilities to revenue levers with explicit kill criteria.\n' +
    '- Frames markets, sizes opportunities, and pressure-tests assumptions.',
  finance:
    'Finance / FP&A — 7 yrs (modeling, valuation, corporate finance).\n' +
    '- Builds 3-statement models and DCFs; careful with growth, margin, capex, and working-capital assumptions vs comps.\n' +
    '- Evaluated capex with NPV/IRR and the IRR-vs-scale trap; presented scenarios with payback and quarterly checkpoints.\n' +
    '- Partners with stakeholders to translate financials for non-finance audiences.',
  operations:
    'Operations Manager — 7 yrs (process, supply chain, Lean/Six Sigma).\n' +
    '- Defines KPI dashboards (throughput, cycle time, SLA, cost per unit) with precise cross-team metric definitions.\n' +
    '- Diagnosed a publish-latency regression (2h to 8h) to a bottleneck and resequenced the process to clear SLA breaches.\n' +
    '- Runs demand forecasting, vendor fill-rate, and SOP standardization.',
  marketing:
    'Growth / Marketing Manager — 6 yrs (paid + lifecycle, full-funnel).\n' +
    '- Owns channel mix (paid search/social, SEO, email) and CAC/ROAS; sets up incrementality measurement, not last-click.\n' +
    '- Diagnoses funnels: strong CTR but weak trial-to-paid and rising CAC -> segment, message, and budget reallocation.\n' +
    '- Runs A/B tests on paywalls and onboarding; reads attribution and retention together.',
  sales:
    'Account Executive / Sales — 7 yrs (B2B SaaS, mid-market + enterprise).\n' +
    '- Runs discovery and qualification with MEDDICC/BANT; maps multi-stakeholder decision processes.\n' +
    '- Handled a quarter-end negotiation at 82% of quota: scoped concessions on a discount + pilot while protecting close probability and forecast.\n' +
    '- Keeps CRM/pipeline hygiene tight; strong on objection handling and renewals.',
  mechanical:
    'Mechanical Engineer — 6 yrs (CAD, FEA, GD&T, manufacturing).\n' +
    '- Thermal design: reduced peak temperature of an aluminum housing ~15C without a fan via conduction/surface-area/material tradeoffs.\n' +
    '- Redesigned a sheet-metal motor bracket under vibration + cyclic startup torque; checked stress concentration, fatigue life, and DFM.\n' +
    '- Uses FEA vs hand-calcs judiciously; owns tolerance stack-ups and design-for-manufacture.',
  civil:
    'Civil / Structural Engineer — 7 yrs (structural analysis, geotech, RCC/steel).\n' +
    '- Designed RCC and steel structures to code (load combinations, serviceability, detailing); coordinated with geotech on foundations.\n' +
    '- Managed site execution: sequencing, QA/QC on concrete and rebar, and SLA-driven inspection checklists.\n' +
    '- Comfortable with STAAD/ETABS, load paths, and constructability tradeoffs.',
  electrical:
    'Electrical Engineer — 6 yrs (power, machines, drives, control).\n' +
    '- Diagnosed intermittent VFD overcurrent trips on a 3-phase motor during high-ambient acceleration (parameter vs thermal-derating vs power-stage).\n' +
    '- Improved power factor and efficiency of motor loads (capacitor correction vs harmonic filtering vs drive topology).\n' +
    '- Tunes PI/PID loops and designs motor-drive inverter stages; instruments with clamp meter, scope, power analyzer.',
  electronics:
    'Electronics Engineer — 6 yrs (analog/digital, RF, embedded).\n' +
    '- Designed receive chains: superheterodyne vs direct-conversion tradeoffs (image rejection, LO leakage, DC offset, phase noise).\n' +
    '- Debugged an audio/RF pipeline for sampling/aliasing vs filter design vs modulation; selects QAM/FM/FSK schemes by link budget.\n' +
    '- Embedded firmware: interrupt latency, timing, and signal-integrity debugging.',
  general:
    'Experienced Professional — 7 yrs across cross-functional roles.\n' +
    '- Owns ambiguous problems end to end: scopes, prioritizes, and drives delivery with clear metrics.\n' +
    '- Communicates crisply to stakeholders; comfortable digging into data to find root cause.\n' +
    '- Adapts quickly to new domains and collaborates across engineering, product, and business.',
}
