location.hash='mode=full&questions=3&autostart=1';
;(async function qaMatrixRunner() {
  const HARNESS_VERSION = '2.5.0'
  const ASSERT_CFG = {
    questionMinLength: 20,
    genQMs: 8000,
    evalMs: 10000,
    consoleErrorAllowlist: ['[QA]', 'QA_TELEMETRY', 'QA_REPORT_'],
  }

  const telemetry = []
  let runReportId = null
  const activityCtx = { matrixKey: '', sessionId: null }
  const consoleRing = []

  ;['log', 'warn', 'error'].forEach((level) => {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      if (level === 'log' && args[0] === 'QA_TELEMETRY') {
        orig(...args)
        return
      }
      consoleRing.push({ level, text: args.map(String).join(' '), timestamp: Date.now() })
      orig(...args)
    }
  })

  function flushConsole() {
    return consoleRing.splice(0, consoleRing.length)
  }

  function assert(id, pass, message, severity) {
    return { id, pass, message, severity: severity || (pass ? 'warn' : 'fail') }
  }

  function evaluateAssertions(bundle) {
    const out = []
    const { step, apiResult, network = [], console: consoleEntries = [] } = bundle
    const meta = bundle.meta || {}

    if (apiResult) {
      out.push(assert('http-ok', apiResult.ok || apiResult.status < 500, 'HTTP ' + apiResult.status, apiResult.status >= 500 ? 'fail' : 'warn'))
      out.push(assert('no-5xx', apiResult.status < 500, 'Status ' + apiResult.status + ' is 5xx', 'fail'))
    }
    for (const n of network) {
      if (n.status != null && n.status >= 500) out.push(assert('net-no-5xx', false, n.method + ' ' + n.url + ' → ' + n.status, 'fail'))
      if (n.failed) out.push(assert('net-not-failed', false, n.method + ' ' + n.url + ' failed', 'fail'))
    }
    for (const c of consoleEntries) {
      if (c.level !== 'error') continue
      const ok = ASSERT_CFG.consoleErrorAllowlist.some((p) => c.text.includes(p))
      if (!ok) out.push(assert('no-console-error', false, 'Console error: ' + c.text.slice(0, 120), 'fail'))
    }
    if (step === 'generate-question' && meta.question != null) {
      out.push(assert('q-nonempty', meta.question.length >= ASSERT_CFG.questionMinLength, 'Question too short', 'fail'))
      if (apiResult?.ms != null) out.push(assert('q-latency', apiResult.ms < ASSERT_CFG.genQMs, 'Slow generate-question', 'warn'))
    }
    if (step === 'evaluate-answer' && meta.eval) {
      for (const dim of ['relevance', 'structure', 'specificity', 'ownership']) {
        out.push(assert('ev-' + dim, Number.isFinite(Number(meta.eval[dim])), 'Missing ' + dim, 'fail'))
      }
      if (apiResult?.ms != null) out.push(assert('ev-latency', apiResult.ms < ASSERT_CFG.evalMs, 'Slow evaluate', 'warn'))
    }
    if (step === 'evaluate-code' && meta.eval) {
      for (const dim of ['correctness', 'efficiency', 'code_quality']) {
        out.push(assert('code-' + dim, Number.isFinite(Number(meta.eval[dim])), 'Missing ' + dim, 'fail'))
      }
      if (apiResult?.ms != null) out.push(assert('code-latency', apiResult.ms < ASSERT_CFG.evalMs, 'Slow evaluate-code', 'warn'))
    }
    if (step === 'evaluate-design' && meta.eval) {
      for (const dim of ['architecture', 'scalability', 'tradeoffs']) {
        if (meta.eval[dim] != null) {
          out.push(assert('design-' + dim, Number.isFinite(Number(meta.eval[dim])), 'Missing ' + dim, 'fail'))
        }
      }
      if (apiResult?.ms != null) out.push(assert('design-latency', apiResult.ms < ASSERT_CFG.evalMs, 'Slow evaluate-design', 'warn'))
    }
    if (step === 'generate-feedback') {
      out.push(assert('fb-response', apiResult?.ok || apiResult?.status === 202, 'Feedback HTTP ' + apiResult?.status, 'fail'))
      if (meta.overallScore != null) out.push(assert('fb-score', meta.overallScore != null, 'overall_score present', 'fail'))
      if (meta.pathwayPlanStatus != null) {
        out.push(assert('fb-pathway-enqueued', meta.pathwayPlanStatus === 'scheduled', 'pathwayPlan ' + meta.pathwayPlanStatus, 'warn'))
      }
    }
    if (step === 'pathway-poll' && meta.pathwayGenerationStatus != null) {
      const terminal = ['succeeded', 'failed', 'skipped'].includes(meta.pathwayGenerationStatus)
      if (meta.pollIndex === meta.pollMax - 1 && !terminal) {
        out.push(assert('pw-succeeded', false, 'Pathway poll timeout', 'fail'))
      }
    }
    if (step === 'analysis-poll' && meta.pollIndex === meta.pollMax - 1) {
      if (!['completed', 'failed'].includes(meta.analysisStatus)) {
        out.push(assert('an-complete', false, 'Analysis poll timeout', 'fail'))
      }
    }
    if (step === 'analysis-poll' && meta.analysisStatus === 'completed') {
      out.push(assert('an-timeline', (meta.timelineEvents ?? 0) > 0, 'Empty timeline', 'warn'))
    }
    return out
  }

  function verdictFromAssertions(assertions) {
    if (assertions.some((a) => !a.pass && a.severity === 'fail')) return 'fail'
    if (assertions.some((a) => !a.pass)) return 'warn'
    return 'pass'
  }

  function emitActivity(stage, step, apiResult, networkEntry, meta) {
    const activityId = activityCtx.matrixKey + '/' + stage + '/' + step
    const bundle = {
      activityId,
      runId: runReportId,
      matrixKey: activityCtx.matrixKey,
      stage,
      step,
      timestamp: new Date().toISOString(),
      durationMs: apiResult?.ms ?? networkEntry?.durationMs ?? 0,
      console: flushConsole(),
      network: networkEntry ? [networkEntry] : [],
      apiResult: apiResult
        ? { ok: apiResult.ok, status: apiResult.status, ms: apiResult.ms, keys: Object.keys(apiResult.data || {}) }
        : undefined,
      meta: meta || {},
      sessionId: activityCtx.sessionId,
      assertions: [],
      verdict: 'pass',
    }
    bundle.assertions = evaluateAssertions(bundle)
    bundle.verdict = verdictFromAssertions(bundle.assertions)
    telemetry.push(bundle)
    console.log('QA_TELEMETRY', JSON.stringify(bundle))
    return bundle
  }

  function emitNetworkActivity(stage, step, method, url, status, durationMs, text, failed, meta) {
    const net = {
      method,
      url,
      status: status ?? null,
      durationMs,
      failed: !!failed,
      responseBodyPreview: (text || '').slice(0, 1000),
    }
    emitActivity(stage, step, { ok: !failed && (status == null || status < 400), status: status ?? 0, ms: durationMs, data: {} }, net, meta)
  }

  const params = new URLSearchParams((location.hash.replace(/^#/, '') || location.search).replace(/^\?/, ''))
  const MODE = params.get('mode') || 'smoke'
  const Q_LIMIT = parseInt(params.get('questions') || '3', 10)
  const RUN_LIMIT = parseInt(params.get('limit') || '0', 10)
  const AUTOSTART = params.get('autostart') === '1'
  const DURATION = parseInt(params.get('duration') || '10', 10)
  const MATRIX_EXPERIENCE = params.get('experience') || '0-2'
  const CELL_OFFSET = parseInt(params.get('offset') || '0', 10)
  const CELL_RETRY = parseInt(params.get('cellRetry') || '1', 10)
  const REPORT_ID_PARAM = params.get('reportId') || null

  let quotaAborted = false
  function QuotaExceeded(status) {
    this.name = 'QuotaExceeded'
    this.status = status
    this.message = 'Usage quota exceeded (HTTP ' + status + ')'
  }

  // __QA_ROSTER_START__ — replaced by npm run qa:build:browser from rosterMatrixData.mjs
  const ROSTER_DOMAINS = [{"slug":"frontend","categorySlug":"programming"},{"slug":"backend","categorySlug":"programming"},{"slug":"sdet","categorySlug":"programming"},{"slug":"data-science","categorySlug":"data-ai"},{"slug":"pm","categorySlug":"product"},{"slug":"design","categorySlug":"design"},{"slug":"business","categorySlug":"business"},{"slug":"mechanical","categorySlug":"core-engineering"},{"slug":"civil","categorySlug":"core-engineering"},{"slug":"electrical","categorySlug":"core-engineering"},{"slug":"electronics","categorySlug":"core-engineering"},{"slug":"fullstack","categorySlug":"programming"},{"slug":"devops","categorySlug":"programming"},{"slug":"mobile","categorySlug":"programming"},{"slug":"ml-engineer","categorySlug":"data-ai"},{"slug":"data-analyst","categorySlug":"data-ai"},{"slug":"strategy","categorySlug":"business"},{"slug":"finance","categorySlug":"business"},{"slug":"operations","categorySlug":"business"},{"slug":"marketing","categorySlug":"business"},{"slug":"sales","categorySlug":"business"},{"slug":"product-analyst","categorySlug":"product"},{"slug":"ui-designer","categorySlug":"design"},{"slug":"product-designer","categorySlug":"design"},{"slug":"general","categorySlug":"general"}]
  const ROSTER_DEPTHS = [{"slug":"behavioral"},{"slug":"technical"},{"slug":"case-study","domains":["pm","business","data-science","design","general"],"categories":["product","business","data-ai","design"]},{"slug":"system-design","domains":["backend","frontend","data-science","sdet","general"],"categories":["programming","data-ai"]},{"slug":"coding","domains":["backend","frontend","data-science","sdet"],"categories":["programming","data-ai"]},{"slug":"academics","categories":["programming","data-ai","core-engineering","business"]}]
  const SMOKE = [["backend","technical"],["frontend","coding"],["pm","case-study"],["ml-engineer","technical"],["finance","case-study"],["mechanical","technical"],["backend","academics"],["marketing","academics"],["mechanical","academics"]]
  const ROSTER_RESUMES = {"frontend":"Senior Frontend Engineer — 6 yrs (React, TypeScript, Next.js).\n- Built a component design system adopted across 14 surfaces; component reuse 23% to 78%.\n- Cut marketing LCP 4.2s to 1.8s via route code-splitting, next/image, and critical-CSS inlining.\n- Owns the accessibility (WCAG AA) workstream; axe-in-CI, focus management, keyboard/SR support.","backend":"Backend Engineer — 7 yrs (Go, Node, Postgres, Redis, Kafka).\n- Designed a sharded URL service at 40M redirects/day, p99 < 12ms (hot-slug Redis cache, async click writes to Kafka).\n- Migrated a payments monolith to event-driven services with dual-write + DLQs; p99 800ms to 120ms, zero data loss.\n- On-call for the checkout SLA; drove a SEV2 rollback in 14 minutes and added canary releases.","sdet":"SDET / Test Engineer — 5 yrs (Playwright, Pytest, CI).\n- Stabilized a 12%-flaky E2E suite to 1.5% with per-worker DB isolation, deterministic seeds, and infra-only retries.\n- Cut suite runtime 38 to 11 minutes via parallel sharding; built a shared test SDK (auth/seeding/artifact fixtures).\n- Added contract tests at service boundaries; production escapes down 40%.","fullstack":"Full-Stack Engineer — 6 yrs (TypeScript, React, Node, Postgres).\n- Shipped features end to end: React/Next front end, REST/tRPC APIs, schema design, and caching.\n- Built a click-tracking flow front-to-DB that stays fast and accurate under a 100:1 read/write ratio.\n- Comfortable across the stack: state management, API contracts, query optimization, and deploys.","devops":"DevOps / SRE — 7 yrs (Kubernetes, Terraform, GitHub Actions, Prometheus).\n- Owns CI/CD with canary + blue-green rollouts; autoscaling via HPA + cluster-autoscaler.\n- Defines SLOs and runs error-budget decisions; on-call lead, MTTR 45 to 8 minutes on recent incidents.\n- IaC for multi-env infra; observability with OpenTelemetry, structured logs, and runbooks.","mobile":"Mobile Engineer — 6 yrs (iOS/Swift + SwiftUI, Android/Kotlin + Compose).\n- Built offline-first sync with conflict resolution for downloadable content; reconciles iOS vs Android lifecycles.\n- Tuned list virtualization, image caching, and jank on mid-range devices; push + deep-link plumbing.\n- Ships cross-platform features and owns release trains for both stores.","data-science":"Data Scientist — 6 yrs (Python, pandas, scikit-learn, SQL).\n- Built classification + ranking models; rigorous train/val/test splits to avoid leakage, calibration over raw AUC.\n- Designed pre-registered A/B holdouts with stop rules; shipped a pricing change at 95% CI on +4.2% revenue.\n- Partners with engineering on feature pipelines and production monitoring.","ml-engineer":"Machine Learning Engineer — 6 yrs (PyTorch, MLflow, Triton, Feast).\n- Rebuilt batch serving (6h lag) into near-real-time inference: online/offline feature store, p99 < 80ms at 50k rps.\n- Owns training pipelines, model registry, shadow traffic, and drift/decay monitoring with retrain + rollback rules.\n- Handles class imbalance, training-serving skew, and metric selection (precision/recall/AUC/calibration).","data-analyst":"Data Analyst — 5 yrs (SQL, pandas, dbt, Looker/Tableau).\n- Investigates metric movements: decomposes funnels/cohorts, separates tracking artifacts from real engagement.\n- Built the metrics layer + dashboards adopted org-wide; wrote the metric dictionary that ended definition disputes.\n- Designs and reads experiments; comfortable with window functions, segmentation, and data-quality checks.","pm":"Product Manager — 7 yrs.\n- Fixed onboarding activation (+19% in 4 weeks) via user interviews, prototypes, and a pre-registered 50/50 test.\n- Owns roadmap and tradeoffs; cut an enterprise ask to protect a billing deadline while offering a phased path.\n- Runs weekly experiment reviews; ties roadmap items to research and metrics.","product-analyst":"Product Analyst — 5 yrs (SQL, Amplitude/Mixpanel, A/B testing).\n- Owns activation/retention metrics; debugs a 7-day retention drop with cohort cuts and SQL, ruling out instrumentation.\n- Defines guardrail metrics and reads experiment results; builds self-serve funnels and tracking plans.\n- Translates product questions into instrumented, statistically sound analyses.","design":"Product Designer — 7 yrs (end-to-end UX: research, IA, prototyping, validation).\n- Diagnosed a 60% drop-off flow with unmoderated sessions + affinity mapping; redesign lifted completion 24%.\n- Built and evolved a design system/component library; shortened design review cycles 9 days to 3.\n- Balances accessibility and visual polish against delivery timelines.","product-designer":"Product Designer — 7 yrs (UX research, IA, interaction design, prototyping).\n- Leads end-to-end product design: problem framing, journey mapping, hi-fi prototypes, and usability validation.\n- Redesigned a subscription paywall and onboarding; partners closely with PM + eng on tradeoffs.\n- Runs design critiques and evolves shared patterns across surfaces.","ui-designer":"UI / Visual Designer — 6 yrs (Figma, design systems, typography, motion).\n- Owns visual craft: type scale, spacing rhythm, color hierarchy, focus states, and responsive breakpoints.\n- Built a Figma component library (variants + constraints) for clean developer handoff and scale.\n- Unified brand typography across apps; cut design review time 35%.","business":"Business Analyst / Generalist — 6 yrs.\n- Diagnoses ambiguous business problems: segments data, correlates with campaigns, tests falsifiable hypotheses.\n- Built a 3-scenario model with sensitivity on churn and ARPU that secured board approval for a pricing change.\n- Comfortable translating analysis into stakeholder recommendations.","strategy":"Strategy Manager — 7 yrs (corporate / product strategy, ex-consulting).\n- Defined a defensible mid-market strategy: segmented by willingness-to-pay, doubled down on enterprise depth, sunset a low-margin tier; win rate +28%.\n- Built a 3-year platform vision mapping capabilities to revenue levers with explicit kill criteria.\n- Frames markets, sizes opportunities, and pressure-tests assumptions.","finance":"Finance / FP&A — 7 yrs (modeling, valuation, corporate finance).\n- Builds 3-statement models and DCFs; careful with growth, margin, capex, and working-capital assumptions vs comps.\n- Evaluated capex with NPV/IRR and the IRR-vs-scale trap; presented scenarios with payback and quarterly checkpoints.\n- Partners with stakeholders to translate financials for non-finance audiences.","operations":"Operations Manager — 7 yrs (process, supply chain, Lean/Six Sigma).\n- Defines KPI dashboards (throughput, cycle time, SLA, cost per unit) with precise cross-team metric definitions.\n- Diagnosed a publish-latency regression (2h to 8h) to a bottleneck and resequenced the process to clear SLA breaches.\n- Runs demand forecasting, vendor fill-rate, and SOP standardization.","marketing":"Growth / Marketing Manager — 6 yrs (paid + lifecycle, full-funnel).\n- Owns channel mix (paid search/social, SEO, email) and CAC/ROAS; sets up incrementality measurement, not last-click.\n- Diagnoses funnels: strong CTR but weak trial-to-paid and rising CAC -> segment, message, and budget reallocation.\n- Runs A/B tests on paywalls and onboarding; reads attribution and retention together.","sales":"Account Executive / Sales — 7 yrs (B2B SaaS, mid-market + enterprise).\n- Runs discovery and qualification with MEDDICC/BANT; maps multi-stakeholder decision processes.\n- Handled a quarter-end negotiation at 82% of quota: scoped concessions on a discount + pilot while protecting close probability and forecast.\n- Keeps CRM/pipeline hygiene tight; strong on objection handling and renewals.","mechanical":"Mechanical Engineer — 6 yrs (CAD, FEA, GD&T, manufacturing).\n- Thermal design: reduced peak temperature of an aluminum housing ~15C without a fan via conduction/surface-area/material tradeoffs.\n- Redesigned a sheet-metal motor bracket under vibration + cyclic startup torque; checked stress concentration, fatigue life, and DFM.\n- Uses FEA vs hand-calcs judiciously; owns tolerance stack-ups and design-for-manufacture.","civil":"Civil / Structural Engineer — 7 yrs (structural analysis, geotech, RCC/steel).\n- Designed RCC and steel structures to code (load combinations, serviceability, detailing); coordinated with geotech on foundations.\n- Managed site execution: sequencing, QA/QC on concrete and rebar, and SLA-driven inspection checklists.\n- Comfortable with STAAD/ETABS, load paths, and constructability tradeoffs.","electrical":"Electrical Engineer — 6 yrs (power, machines, drives, control).\n- Diagnosed intermittent VFD overcurrent trips on a 3-phase motor during high-ambient acceleration (parameter vs thermal-derating vs power-stage).\n- Improved power factor and efficiency of motor loads (capacitor correction vs harmonic filtering vs drive topology).\n- Tunes PI/PID loops and designs motor-drive inverter stages; instruments with clamp meter, scope, power analyzer.","electronics":"Electronics Engineer — 6 yrs (analog/digital, RF, embedded).\n- Designed receive chains: superheterodyne vs direct-conversion tradeoffs (image rejection, LO leakage, DC offset, phase noise).\n- Debugged an audio/RF pipeline for sampling/aliasing vs filter design vs modulation; selects QAM/FM/FSK schemes by link budget.\n- Embedded firmware: interrupt latency, timing, and signal-integrity debugging.","general":"Experienced Professional — 7 yrs across cross-functional roles.\n- Owns ambiguous problems end to end: scopes, prioritizes, and drives delivery with clear metrics.\n- Communicates crisply to stakeholders; comfortable digging into data to find root cause.\n- Adapts quickly to new domains and collaborates across engineering, product, and business."}
  const DOMAIN_CATEGORY = Object.fromEntries(ROSTER_DOMAINS.map((d) => [d.slug, d.categorySlug]))
  const DOMAINS = ROSTER_DOMAINS.map((d) => d.slug)
  const DEPTHS = ROSTER_DEPTHS
  function depthApplies(domainSlug, depthSlug) {
    const categorySlug = DOMAIN_CATEGORY[domainSlug] || 'general'
    const d = ROSTER_DEPTHS.find((x) => x.slug === depthSlug)
    if (!d) return false
    const domains = d.domains || []
    const cats = d.categories || []
    if (domains.length === 0 && cats.length === 0) return true
    if (domains.includes(domainSlug)) return true
    return cats.includes(categorySlug)
  }
  function applicable(domain, depth) {
    return depthApplies(domain, depth)
  }
  // __QA_ROSTER_END__
  const PERSONAS = ['strong','weak']
  const ANSWERS = {
    behavioral:{strong:'At Acme I led a cross-functional launch that cut checkout drop-off by 38% in six weeks with clear metrics and ownership.',weak:'I worked on a project with my team and we improved things. It went well.'},
    technical:{strong:'We migrated to event-driven microservices on Kafka, cut p99 from 800ms to 120ms, with DLQs and phased rollout.',weak:'We moved to microservices and used Kafka. It was faster.'},
    'case-study':{strong:'Goal 15% MAU growth: sized market, prioritized referral + onboarding, expected +3.2pp conversion.',weak:'I would grow users with marketing and improve the product.'},
    'system-design':{strong:'10M DAU, CDN, stateless API, Postgres + replicas, Redis cache, SQS workers, 99.9% SLA trade-offs documented.',weak:'Load balancer, database, cache, scale horizontally.'},
    coding:{strong:'Hash map O(n) time O(k) space, handle empty input and edge cases, sort by frequency.',weak:'Loop and count with a hash map probably.'},
    academics:{strong:'My strongest subject is the core theory of my field — I can derive the key results from first principles, state the assumptions they rest on, and connect them to adjacent topics rather than just reciting definitions.',weak:'I guess the main theory we studied. I remember some of the definitions but I am not really sure why they work — I would have to look most of it up.'},
  }

  let logEl = null
  let pre = null

  function mountUi() {
    document.body.innerHTML =
      '<h1 style="font:16px sans-serif;padding:12px">QA Matrix Runner (browser session)</h1>' +
      '<div id="qa-log" style="font:13px monospace;padding:12px;white-space:pre-wrap;max-height:40vh;overflow:auto;background:#111;color:#0f0"></div>' +
      '<pre id="qa-result" style="font:11px monospace;padding:12px;white-space:pre-wrap;word-break:break-all"></pre>'
    document.body.style.background = '#fff'
    logEl = document.getElementById('qa-log')
    pre = document.getElementById('qa-result')
  }

  const log = (m) => {
    if (logEl) {
      logEl.textContent += m + '\n'
      logEl.scrollTop = logEl.scrollHeight
    }
    console.log('[QA]', m)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // __QA_INJECT_START__ — replaced by npm run qa:build:browser from strongAnswers.json + strongAnswerRouter.mjs
  const STRONG_ANSWERS_CONFIG = {"version":1,"byBucket":{"accessibility":"Situation: Fourteen product surfaces had inconsistent focus order and contrast. Task: Ship WCAG AA compliance without a rewrite. Action: I defined tokens, built accessible primitives, audited with axe in CI, and ran a six-week migration sprint. Result: Component reuse rose to 78%; a11y defects down 60%.","adaptability":"Situation: Leadership pivoted our Q3 roadmap mid-quarter after a competitor launch. Task: Realign the team without losing momentum. Action: I ran a 48-hour reprioritization workshop, communicated tradeoffs transparently, and protected one committed customer deadline. Result: Shipped the revised roadmap on time with 90% team confidence in the new plan.","analytical":"Situation: Conversion dropped 12% week-over-week with no obvious cause. Task: Find root cause before reverting a launch. Action: I decomposed the funnel by segment, correlated with deploys and campaigns, and ran two falsifiable analyses. Result: Identified a tracking bug in 36 hours; true conversion was flat after fix.","automation":"Situation: E2E tests were 12% flaky and blocked every deploy. Task: Stabilize CI without slowing dev. Action: I isolated DB state per worker, added deterministic seeding, parallelized to four workers, and retried only infra failures. Result: Flake rate 1.5%; suite time 38 to 11 minutes.","collaboration":"Situation: Two senior engineers blocked a release over an architecture choice. Task: Unblock without picking sides prematurely. Action: I ran a decision review with explicit criteria, surfaced delay cost, and chose the reversible option with a six-week revisit. Result: Shipped on time; both leads signed off on the process.","communication":"Situation: A cross-team initiative had conflicting status reports to leadership. Task: Establish a single narrative. Action: I created a weekly one-pager with metrics, risks, and asks; ran async pre-reads before the staff meeting. Result: Exec escalations dropped 70%; decision latency fell from two weeks to four days.","component-architecture":"Situation: Frontend teams duplicated UI logic across fourteen apps. Task: Introduce a shared component layer. Action: I defined composition patterns, versioning policy, and a migration ladder with codemods for the top five components. Result: Shared library adoption hit 78% in two quarters; duplicate UI bugs down 45%.","data-communication":"Situation: Stakeholders misread a dashboard showing opposite trends in two tools. Task: Restore trust in metrics. Action: I reconciled definitions with data eng, published a metric dictionary, and added lineage notes to every chart. Result: Support tickets on data confusion dropped 80%; one source of truth adopted org-wide.","data-driven":"Situation: Product debated a pricing change with anecdotal evidence only. Task: Decide with data under time pressure. Action: I designed a four-week holdout test, pre-registered the primary metric, and set stop rules. Result: Shipped pricing with 95% CI on +4.2% revenue; no post-hoc debate.","design-process":"Situation: Design reviews ballooned to four rounds per feature. Task: Shorten cycle time without quality loss. Action: I introduced a two-stage review (concept vs polish), async critique templates, and a 48-hour SLA. Result: Median review cycles dropped from nine days to three; NPS on design partnership rose 18 points.","design-systems":"Situation: Fourteen surfaces had inconsistent UI and slow design delivery. Task: Roll out a shared design system. Action: I defined tokens, built WCAG AA primitives, and ran a six-week migration sprint with adoption metrics. Result: Component reuse 23% to 78%; design QA tickets down 60%.","execution":"Situation: Eleven inbound requests threatened our Q3 outcomes. Task: Prioritize ruthlessly. Action: I aligned on three outcomes, scored each request, said no to six with written rationale. Result: Hit all three outcomes versus missing two the prior quarter.","experimentation":"Situation: We shipped features without learning whether they worked. Task: Institutionalize experiment readouts. Action: I mandated pre-registered metrics, 50/50 flags, and a weekly experiment review. Result: Experiment velocity doubled; rollback rate on failed bets dropped 40%.","financial-acumen":"Situation: A feature had strong usage but unclear unit economics. Task: Build a ROI case for continued investment. Action: I modeled infra cost, support load, and incremental revenue with conservative assumptions; presented three scenarios to finance. Result: Secured funding with a payback target of 14 months and quarterly checkpoints.","leadership":"Situation: Legal, security, and design were misaligned on a consent flow. Task: Ship compliant UX without formal authority. Action: I built a tradeoff doc, ran 1:1s before the group meeting, and facilitated agreement in nine days. Result: Single design shipped; consent support tickets down 35%.","ml-engineering":"Situation: Model serving lagged six hours behind training data. Task: Rebuild for near-real-time inference. Action: I moved features to a Redis store with TTL, served via Triton with autoscale, and added shadow traffic for new models. Result: p99 inference under 80ms at 50k rps; rollback path tested monthly.","motivation":"Situation: I joined a team with low morale after a missed launch. Task: Rebuild momentum on a visible win. Action: I scoped a two-week quick win, celebrated progress publicly, and paired juniors with seniors on the next milestone. Result: Team eNPS rose 22 points; attrition stabilized over two quarters.","operational":"Situation: A release spiked failed publishes within two hours of launch. Task: Restore service and identify root cause. Action: I declared SEV2, rolled back in 14 minutes, traced a failing async job, and posted hourly updates. Result: Success rate recovered same day; added canary releases.","ownership":"Situation: A cross-team launch had no clear DRI and slipped twice. Task: Own end-to-end delivery. Action: I wrote a RACI, ran weekly demos, and personally owned QA on edge cases. Result: Launched on day 42 with 68% weekly retention among beta users.","performance":"Situation: Marketing LCP was 4.2s hurting conversion. Task: Improve Core Web Vitals without a rewrite. Action: I code-split routes, deferred third-party scripts, and moved images to next/image. Result: LCP 1.8s; Lighthouse mobile 42 to 89; organic conversion +11%.","problem-solving":"Situation: Retention moved opposite directions in two dashboards during a test. Task: Decide with ambiguous data. Action: I reconciled definitions, reran on raw events, time-boxed investigation, and documented assumptions. Result: Found a tagging bug; shipped with confidence.","product-sense":"Situation: Activation stalled at step three of onboarding. Task: Find the friction without over-building. Action: I ran twelve user sessions, mapped drop-off, and prototyped three lightweight fixes behind a flag. Result: Activation rose 19% in four weeks.","quality-advocacy":"Situation: Releases shipped with known regressions due to schedule pressure. Task: Raise quality bar without being a blocker. Action: I introduced quality gates in CI, published a risk rubric, and offered phased rollouts as an alternative to delay. Result: Sev-2 incidents down 55%; deploy frequency unchanged.","self-awareness":"Situation: I owned a migration that dropped 4% of payment events on day one. Task: Restore integrity and learn. Action: I rolled back in 18 minutes, ran a blameless postmortem, and added contract tests. Result: Zero data loss on retry; runbook still in use.","stakeholder-management":"Situation: Sales wanted a custom enterprise feature that would delay billing by six weeks. Task: Manage fallout from saying no. Action: I quantified revenue impact both ways, offered a phased alternative, and committed to a follow-up date. Result: Billing shipped on time; $1.2M ARR added that quarter.","statistical-thinking":"Situation: An experiment showed lift but the sample was underpowered. Task: Advise ship or extend. Action: I recomputed power, checked for peeking, and recommended two more weeks with a fixed horizon. Result: Confirmed lift at p<0.05; avoided a false launch.","strategic-thinking":"Situation: Leadership asked for a three-year platform vision. Task: Connect tech choices to business outcomes. Action: I mapped capabilities to revenue levers, identified two strategic bets, and defined kill criteria. Result: Board approved the roadmap; both bets hit year-one milestones.","strategy":"Situation: Our product was losing mid-market deals to a cheaper competitor. Task: Define a defensible strategy. Action: I segmented customers by willingness-to-pay, doubled down on enterprise workflow depth, and sunset a low-margin tier. Result: Win rate in target segment rose 28% in two quarters.","technical-breadth":"Situation: A outage spanned API, cache, and async workers. Task: Lead triage across stacks. Action: I correlated traces across services, split the war room by layer, and rolled back the API canary first. Result: MTTR 45 minutes to 8 minutes on the last three incidents.","technical-depth":"Situation: We migrated payments from a monolith to Kafka event-driven services. Task: Cut latency without data loss. Action: Phased rollout with dual-write, DLQs, and replay tooling. Result: p99 800ms to 120ms across 14B events with zero data loss.","technical-literacy":"Situation: PMs and designers couldn't evaluate eng estimates. Task: Improve shared technical fluency. Action: I ran monthly architecture brown bags and a glossary tied to our stack. Result: Estimate variance dropped 30%; cross-functional planning meetings shortened by 25%.","test-strategy":"Situation: QA couldn't keep up with weekly releases. Task: Redesign the test pyramid. Action: I shifted critical paths to integration tests, capped E2E to ten smoke flows, and added contract tests at service boundaries. Result: Release confidence up; production escapes down 40%.","user-research":"Situation: We built a feature leadership loved but users ignored. Task: Instill research before build. Action: I mandated problem interviews for every epic, synthesized insights in a shared repository, and tied roadmap items to research IDs. Result: Feature adoption on researched bets 2.3x higher than un-researched.","ux-engineering":"Situation: Marketing LCP was 4.2s on React pages. Task: Improve UX metrics without a rewrite. Action: I code-split routes, inlined critical CSS, and optimized images. Result: LCP 1.8s; conversion +11%.","visual-design":"Situation: Brand refresh caused inconsistent typography across apps. Task: Unify visual language. Action: I defined type scale, spacing rhythm, and illustration guidelines with Figma libraries. Result: Design review time down 35%; brand consistency score up in quarterly audit."},"byDomainBucket":{"backend:technical-depth":"Situation: We built a URL shortener doing 40M redirects/day. Task: Minimize redirect latency with analytics. Action: Base62 IDs from a sharded counter, Redis cache for hot slugs, async click writes to Kafka. Result: p99 redirect under 12ms; analytics within 30 seconds.","backend:operational":"Situation: Article publish failures spiked after a cache migration. Task: Restore publishes and feed freshness. Action: SEV2 declared, rolled back canary in 14 minutes, traced bad cache keys in logs. Result: Publish success recovered; postmortem added canary checklist.","frontend:technical-depth":"Situation: Marketing LCP was 4.2s hurting conversion. Task: Improve Core Web Vitals. Action: Code-split routes, deferred third-party scripts, next/image, critical CSS inline. Result: LCP 1.8s; Lighthouse 42 to 89.","frontend:ux-engineering":"Situation: Interaction jank on a data-heavy dashboard. Task: Smooth rendering without rewrite. Action: Virtualized lists, memoized row components, moved filters to URL state. Result: INP improved 40%; support tickets on slowness down 50%.","sdet:test-strategy":"Situation: E2E suite was 12% flaky at 38 minutes. Task: Stabilize and speed up CI. Action: Per-worker isolated data, deterministic seeds, parallel sharding, retry only infra errors. Result: Flake 1.5%; runtime 11 minutes.","sdet:automation":"Situation: Teams wrote duplicate Playwright helpers. Task: Ship a shared test SDK. Action: Built fixtures for auth, API seeding, and artifact upload; documented extension points. Result: New test authoring time cut 50%; flake detection dashboard adopted by four teams.","sdet:quality-advocacy":"Situation: Releases skipped regression when behind schedule. Task: Make quality visible without blocking. Action: Published a risk rubric, quality gates on P0 flows, and phased rollout option. Result: Production escapes down 55%.","data-science:ml-engineering":"Situation: Batch predictions lagged six hours. Task: Near-real-time serving. Action: Feature store in Redis, Flink for streaming features, Triton for inference with shadow traffic. Result: End-to-end latency twelve minutes; drift alerts weekly.","data-science:statistical-thinking":"Situation: Leadership wanted to ship a model with thin validation. Task: Set evidence bar. Action: I defined holdout protocol, checked calibration and slice metrics, and documented limitations. Result: Shipped with monitoring; no rollback in first 90 days.","pm:product-sense":"Situation: Activation stalled at onboarding step three. Task: Fix friction fast. Action: Twelve user interviews, three prototypes, 50/50 experiment with pre-registered metric. Result: Activation +19% in four weeks.","pm:stakeholder-management":"Situation: Sales wanted custom enterprise work that delayed billing six weeks. Task: Say no with a path forward. Action: Revenue model both ways, phased alternative, committed follow-up. Result: Billing on time; $1.2M ARR added.","pm:execution":"Situation: Creator analytics MVP due in six weeks with two engineers. Task: Launch without over-scoping. Action: Cut to three metrics from interviews, weekly demos, owned QA. Result: Day-42 launch; 68% weekly retention in beta.","design:design-process":"Situation: Design reviews averaged four rounds per feature. Task: Shorten cycles. Action: Two-stage review, async templates, 48-hour SLA. Result: Median review nine days to three.","design:user-research":"Situation: We shipped a flow users abandoned at 60%. Task: Diagnose before iterating. Action: Eight unmoderated sessions, affinity map, two targeted fixes behind a flag. Result: Completion +24% in three weeks.","business:financial-acumen":"Situation: A pricing change needed board approval. Task: Build a defensible model. Action: Three scenarios with conservative assumptions, sensitivity on churn and ARPU. Result: Approved with quarterly checkpoints; hit base case in Q2.","business:analytical":"Situation: Regional sales diverged with no clear driver. Task: Recommend action. Action: Pivot analysis by region and product, correlated with campaigns, tested two hypotheses. Result: Identified underperforming channel; reallocated spend for +8% pipeline."},"bySlot":{},"depthFallback":{"behavioral":"Situation: At Acme I led a cross-functional launch that cut checkout drop-off by 38% in six weeks. Action: I ran weekly experiments with engineering and design, scoped phased rollout behind flags, and owned metrics reviews. Result: Conversion improved 38% and became the template for later launches.","technical":"Situation: We migrated to event-driven microservices on Kafka. Task: Cut latency without data loss. Action: Phased rollout with dual-write, DLQs, and replay tooling. Result: p99 800ms to 120ms with zero data loss.","case-study":"Goal: 15% MAU growth in two quarters. I sized the market, prioritized referral and onboarding, modeled +3.2pp at activation, and would gate rollout on a four-week holdout with a pre-registered primary metric.","system-design":"For 10M DAU: CDN at edge, stateless API behind ALB, Postgres primary with read replicas, Redis cache, SQS workers, OpenTelemetry observability, 99.9% SLA with documented single-region trade-offs.","coding":"Hash map for O(n) lookup versus O(n²) brute force. Iterate once collecting counts, second pass for the result. Handle empty input, duplicates, and tie-breaking explicitly.","academics":"My strongest subject is the core theory of my field, and I'm most comfortable when I can reason about it from first principles rather than just recall a formula. The main areas I've studied are its foundational definitions, the mechanisms behind them, and how they connect to adjacent topics. I'd rather explain why a standard result holds, derive it, and state the assumptions it rests on than quote it from memory; if I don't know an exact constant I'll say so and reason from the relationship instead, then sanity-check the magnitude."}}
  function pickStrongAnswer(domain, depth, flowMeta) {
    const bucket = flowMeta && flowMeta.competencyBucket
    const slotId = flowMeta && flowMeta.slotId
    if (slotId && STRONG_ANSWERS_CONFIG.bySlot && STRONG_ANSWERS_CONFIG.bySlot[slotId]) {
      return { answer: STRONG_ANSWERS_CONFIG.bySlot[slotId], route: 'slot:' + slotId }
    }
    if (bucket && domain) {
      const dbKey = domain + ':' + bucket
      if (STRONG_ANSWERS_CONFIG.byDomainBucket && STRONG_ANSWERS_CONFIG.byDomainBucket[dbKey]) {
        return { answer: STRONG_ANSWERS_CONFIG.byDomainBucket[dbKey], route: 'domain-bucket:' + dbKey }
      }
    }
    if (bucket && STRONG_ANSWERS_CONFIG.byBucket && STRONG_ANSWERS_CONFIG.byBucket[bucket]) {
      return { answer: STRONG_ANSWERS_CONFIG.byBucket[bucket], route: 'bucket:' + bucket }
    }
    const fb = (STRONG_ANSWERS_CONFIG.depthFallback && (STRONG_ANSWERS_CONFIG.depthFallback[depth] || STRONG_ANSWERS_CONFIG.depthFallback.behavioral)) || 'Situation: At Acme I led a cross-functional initiative with clear metrics and ownership.'
    return { answer: fb, route: bucket ? 'depth-fallback:' + depth : 'no-flowMeta:' + depth }
  }
  function scoreQuestionGates(avg, persona, hasEval, depth) {
    const g1Pipeline = hasEval && avg != null
    if (depth === 'coding') {
      const g2Separation = persona === 'weak' ? (g1Pipeline ? true : null) : null
      const g3Relevance = persona === 'strong' && avg != null ? avg >= 60 : null
      const bandOk = persona === 'weak' ? g1Pipeline : (g1Pipeline && g3Relevance === true)
      return { g1Pipeline, g2Separation, g3Relevance, bandOk }
    }
    if (depth === 'system-design') {
      const g2Separation = persona === 'weak' ? (g1Pipeline ? true : null) : null
      const g3Relevance = persona === 'strong' && avg != null ? avg >= 60 : null
      const bandOk = persona === 'weak' ? g1Pipeline : (g1Pipeline && g3Relevance === true)
      return { g1Pipeline, g2Separation, g3Relevance, bandOk }
    }
    const g2Separation = persona === 'weak' && avg != null ? avg <= 55 : null
    const g3Relevance = persona === 'strong' && avg != null ? avg >= 60 : null
    const bandOk = persona === 'weak' ? (g1Pipeline && g2Separation === true) : g1Pipeline
    return { g1Pipeline, g2Separation, g3Relevance, bandOk }
  }

  function plannedCountForHarness(iv) {
    const t = iv.config?.interviewType
    if (t === 'coding' || t === 'system-design') return Math.max(1, iv.evaluations.length || iv.questions.length)
    return iv.questions.length
  }

  const HARNESS_TWO_SUM = {
    id: 'harness-two-sum',
    title: 'Two Sum',
    description:
      'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. You may assume each input has exactly one solution.',
  }
  // __QA_INJECT_END__

  function buildAnswer(flowMeta, domain, depth, persona) {
    if (persona === 'strong') return pickStrongAnswer(domain, depth, flowMeta)
    return { answer: (ANSWERS[depth] || ANSWERS.behavioral).weak, route: 'weak-template:' + depth }
  }

  function buildRuns() {
    const runs = []
    const cells = MODE === 'smoke' ? SMOKE.map(([domain, depth]) => ({ domain, depth }))
      : DOMAINS.flatMap((domain) => DEPTHS.map((d) => ({ domain, depth: d.slug })))
    for (const cell of cells) {
      for (const persona of PERSONAS) {
        runs.push({ ...cell, persona, runId: `${cell.domain}__${cell.depth}__${persona}` })
      }
    }
    return runs
  }

  async function api(method, route, body, activity) {
    const t0 = performance.now()
    let res
    let text = ''
    let failed = false
    try {
      res = await fetch(route, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      text = await res.text()
    } catch (err) {
      failed = true
      text = String(err.message || err)
    }
    const ms = Math.round(performance.now() - t0)
    let data = {}
    if (!failed) {
      try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 500) } }
    }
    const result = { ok: !failed && res?.ok, status: failed ? 0 : res.status, data, ms }
    if (!failed && (res.status === 402 || res.status === 403)) {
      quotaAborted = true
      throw new QuotaExceeded(res.status)
    }
    if (activity) {
      const net = {
        method,
        url: route,
        status: failed ? null : res.status,
        durationMs: ms,
        failed,
        responseBodyPreview: text.slice(0, 1000),
      }
      const meta = typeof activity.meta === 'function' ? activity.meta(result) : (activity.meta || {})
      emitActivity(activity.stage, activity.step, result, net, meta)
    }
    return result
  }

  function avgScore(ev) {
    const dims = ['relevance','structure','specificity','ownership']
    const v = dims.map((d) => Number(ev[d])).filter((n) => Number.isFinite(n))
    return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : 0
  }

  function synthWords(transcript) {
    const words = []
    let cursor = 0
    for (const e of transcript) {
      if (e.speaker !== 'candidate') continue
      for (const w of e.text.split(/\s+/).filter(Boolean)) {
        words.push({ word: w, start: cursor, end: cursor + 0.25, confidence: 0.92 })
        cursor += 0.3
      }
      cursor += 0.8
    }
    if (!words.length) words.push({ word: 'hello', start: 0, end: 0.2, confidence: 0.9 })
    return words
  }

  async function runInterview(domain, depth, persona) {
    const config = { role: domain, interviewType: depth, experience: MATRIX_EXPERIENCE, duration: DURATION, privacyMode: true, resumeText: ROSTER_RESUMES[domain] || '' }
    const create = await api('POST', '/api/interviews', { config }, { stage: 'interview', step: 'create' })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    activityCtx.sessionId = sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() }, { stage: 'interview', step: 'patch-start' })

    const transcript = []
    const evaluations = []
    const questions = []
    let t = Date.now()

    for (let qi = 0; qi < Q_LIMIT; qi++) {
      let gq = await api('POST', '/api/generate-question', {
        config, questionIndex: qi, previousQA: transcript, sessionId,
        performanceSignal: persona === 'strong' ? 'on_track' : 'struggling',
      }, {
        stage: 'interview',
        step: 'generate-question',
        meta: (r) => ({
          questionIndex: qi,
          question: r.data.question || '',
          flowMeta: r.data.flowHints || null,
        }),
      })
      if ((!gq.ok || !gq.data?.question) && (gq.status >= 500 || gq.status === 504 || gq.status === 0)) {
        await sleep(2500)
        gq = await api('POST', '/api/generate-question', {
          config, questionIndex: qi, previousQA: transcript, sessionId,
          performanceSignal: persona === 'strong' ? 'on_track' : 'struggling',
        }, { stage: 'interview', step: 'generate-question-retry' })
      }
      const flowMeta = gq.data.flowHints || null
      const question = gq.data.question || ''
      if (!question) {
        throw new Error('generate-question returned empty question (status ' + gq.status + ')')
      }
      const built = buildAnswer(flowMeta, domain, depth, persona)
      const answer = built.answer
      transcript.push({ speaker: 'interviewer', text: question, timestamp: t, questionIndex: qi })
      t += 500
      transcript.push({ speaker: 'candidate', text: answer, timestamp: t, questionIndex: qi })
      t += 2000
      const ev = await api('POST', '/api/evaluate-answer', { config, question, answer, questionIndex: qi, sessionId }, {
        stage: 'interview',
        step: 'evaluate-answer',
        meta: (r) => ({ questionIndex: qi, eval: r.ok ? r.data : null }),
      })
      if (ev.ok) evaluations.push(ev.data)
      await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, status: 'in_progress' }, { stage: 'interview', step: 'patch-progress' })
      const avg = ev.ok ? avgScore(ev.data) : null
      const gates = scoreQuestionGates(avg, persona, ev.ok, depth)
      questions.push({
        qi, question, answer, persona,
        flowMeta,
        answerRoute: built.route,
        eval: ev.ok ? ev.data : null,
        avg,
        genMs: gq.ms, evalMs: ev.ms,
        gates,
        bandOk: gates.bandOk,
        g3Relevance: gates.g3Relevance,
      })
    }

    const liveTranscriptWords = synthWords(transcript)
    await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, liveTranscriptWords, status: 'in_progress' }, { stage: 'interview', step: 'patch-pre-feedback' })
    return { sessionId, config, transcript, evaluations, questions, liveTranscriptWords }
  }

  function clampFeedbackText(text, maxLength) {
    if (String(text || '').length <= maxLength) return String(text || '')
    return String(text || '').slice(0, Math.max(0, maxLength - 27)) + '\n[truncated for feedback]'
  }

  function feedbackFlags(value) {
    return Array.isArray(value)
      ? value.filter((f) => typeof f === 'string').slice(0, 20).map((f) => clampFeedbackText(f, 500))
      : []
  }

  function codeEvalToStandard(ev, problem, submission) {
    return {
      questionIndex: Number.isFinite(Number(ev.questionIndex)) ? Number(ev.questionIndex) : 1,
      question: clampFeedbackText(`Coding challenge: ${problem.title}. ${problem.description}`, 2000),
      answer: clampFeedbackText(submission.code, 10000),
      relevance: ev.correctness ?? 0,
      structure: ev.code_quality ?? 0,
      specificity: ev.efficiency ?? 0,
      ownership: ev.edge_cases ?? ev.communication ?? 0,
      primaryGap: 'technical_accuracy',
      primaryStrength: 'code_quality',
      answerSummary: ev.feedback || `Submitted ${submission.language} solution for ${problem.title}.`,
      feedback: ev.feedback,
      status: 'ok',
      flags: feedbackFlags(ev.flags),
    }
  }

  function designEvalToStandard(ev, problemTitle, problemDescription, components, connections) {
    return {
      questionIndex: Number.isFinite(Number(ev.questionIndex)) ? Number(ev.questionIndex) : 1,
      question: clampFeedbackText(`System design challenge: ${problemTitle}. ${problemDescription}`, 2000),
      answer: clampFeedbackText(`Design diagram with ${components.length} components and ${connections.length} connections: ${components.map((c) => c.label).join(', ')}`, 10000),
      relevance: ev.requirements_clarity ?? ev.architecture ?? 0,
      structure: ev.architecture ?? 0,
      specificity: ev.scalability ?? 0,
      ownership: ev.tradeoffs ?? ev.communication ?? 0,
      primaryGap: 'system_design',
      primaryStrength: 'architecture',
      answerSummary: ev.feedback || `Submitted architecture diagram for ${problemTitle}.`,
      feedback: ev.feedback,
      status: 'ok',
      flags: feedbackFlags(ev.flags),
    }
  }

  const HARNESS_CODE = {
    strong: `function twoSum(nums, target) {
  const map = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) return [map.get(complement), i];
    map.set(nums[i], i);
  }
  return [];
}`,
    weak: `function twoSum(nums, target) {
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) return [i, j];
    }
  }
}`,
  }

  async function runCodingInterview(domain, persona) {
    const depth = 'coding'
    const config = { role: domain, interviewType: depth, experience: MATRIX_EXPERIENCE, duration: DURATION, privacyMode: true, resumeText: ROSTER_RESUMES[domain] || '' }
    const create = await api('POST', '/api/interviews', { config }, { stage: 'interview', step: 'create' })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    activityCtx.sessionId = sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() }, { stage: 'interview', step: 'patch-start' })

    // Observe the role+resume-aware coding generator (quality signal only — eval
    // still uses the deterministic fixture below so scoring stays stable, RCA-4b).
    await api('POST', '/api/code/generate-problem', {
      domain, experience: MATRIX_EXPERIENCE, solvedProblemIds: [],
      resumeText: ROSTER_RESUMES[domain] || '',
    }, {
      stage: 'interview', step: 'generate-problem-observe',
      meta: (r) => ({
        ok: r.ok, status: r.status,
        title: r.ok ? (r.data?.problem?.title || '') : '',
        tags: r.ok ? (r.data?.problem?.tags || []) : [],
      }),
    })

    // RCA-4b: static Two Sum fixture — avoids domain-generated problem mismatch.
    const problem = HARNESS_TWO_SUM
    const gen = { ok: true, data: { problem }, ms: 0 }

    const code = persona === 'strong' ? HARNESS_CODE.strong : HARNESS_CODE.weak
    const ev = await api('POST', '/api/evaluate-code', {
      code,
      language: 'javascript',
      problemTitle: problem.title,
      problemDescription: problem.description,
      questionIndex: 1,
      sessionId,
    }, {
      stage: 'interview',
      step: 'evaluate-code',
      meta: (r) => ({ questionIndex: 1, eval: r.ok ? r.data : null }),
    })

    const stdEval = ev.ok ? codeEvalToStandard(ev.data, problem, { code, language: 'javascript' }) : null
    let t = Date.now()
    const transcript = [
      { speaker: 'interviewer', text: 'Coding challenge — submit your solution when ready.', timestamp: t, questionIndex: 0 },
    ]
    t += 500
    transcript.push({ speaker: 'interviewer', text: `Problem: ${problem.title}. ${problem.description.slice(0, 120)}…`, timestamp: t, questionIndex: 1 })
    t += 500
    transcript.push({ speaker: 'candidate', text: '[Code submitted in javascript]', timestamp: t, questionIndex: 1 })

    const evaluations = stdEval ? [stdEval] : []
    const avg = stdEval ? avgScore(stdEval) : null
    const gates = scoreQuestionGates(avg, persona, !!stdEval, 'coding')
    const questions = [{
      qi: 1,
      question: problem.title,
      answer: '[javascript code]',
      persona,
      eval: stdEval,
      avg,
      genMs: gen.ms,
      evalMs: ev.ms,
      gates,
      bandOk: gates.bandOk,
      g3Relevance: gates.g3Relevance,
    }]

    const liveTranscriptWords = synthWords(transcript)
    await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, liveTranscriptWords, status: 'in_progress' }, { stage: 'interview', step: 'patch-pre-feedback' })
    return { sessionId, config, transcript, evaluations, questions, liveTranscriptWords }
  }

  async function runDesignInterview(domain, persona) {
    const depth = 'system-design'
    const config = { role: domain, interviewType: depth, experience: MATRIX_EXPERIENCE, duration: DURATION, privacyMode: true, resumeText: ROSTER_RESUMES[domain] || '' }
    const create = await api('POST', '/api/interviews', { config }, { stage: 'interview', step: 'create' })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    activityCtx.sessionId = sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() }, { stage: 'interview', step: 'patch-start' })

    // Observe the role+resume-aware system-design generator (quality signal only —
    // eval still uses the deterministic URL-shortener fixture below).
    await api('POST', '/api/design/generate-problem', {
      domain, experience: MATRIX_EXPERIENCE, solvedProblemIds: [],
      resumeText: ROSTER_RESUMES[domain] || '',
    }, {
      stage: 'interview', step: 'generate-problem-observe',
      meta: (r) => ({
        ok: r.ok, status: r.status,
        title: r.ok ? (r.data?.problem?.title || '') : '',
        components: r.ok ? (r.data?.problem?.expectedComponents || []) : [],
      }),
    })

    const problemTitle = 'Design a URL Shortener'
    const problemDescription = 'Design a URL shortening service like bit.ly. Users submit long URLs and receive short URLs; visits redirect to the original.'
    const requirements = [
      'Shorten a given URL to a unique short URL',
      'Redirect short URLs to the original URL',
      'Handle high read throughput',
      'Track click counts per URL',
    ]
    const components = [
      { id: 'client', type: 'client', label: 'Client', x: 50, y: 50 },
      { id: 'lb', type: 'load_balancer', label: 'Load Balancer', x: 200, y: 50 },
      { id: 'api', type: 'web_server', label: 'API Server', x: 350, y: 50 },
      { id: 'cache', type: 'cache', label: 'Redis Cache', x: 350, y: 150 },
      { id: 'db', type: 'database', label: 'Database', x: 500, y: 50 },
    ]
    if (persona === 'weak') {
      components.splice(2, 2)
    }
    const connections = [
      { id: 'c1', from: 'client', to: 'lb', label: 'HTTPS' },
      { id: 'c2', from: 'lb', to: 'api', label: 'HTTP' },
      ...(persona === 'strong'
        ? [
            { id: 'c3', from: 'api', to: 'cache', label: 'read-through' },
            { id: 'c4', from: 'api', to: 'db', label: 'persist' },
          ]
        : [{ id: 'c3', from: 'lb', to: 'db', label: 'direct' }]),
    ]

    const ev = await api('POST', '/api/evaluate-design', {
      components,
      connections,
      problemTitle,
      problemDescription,
      requirements,
      questionIndex: 1,
      sessionId,
    }, {
      stage: 'interview',
      step: 'evaluate-design',
      meta: (r) => ({ questionIndex: 1, eval: r.ok ? r.data : null }),
    })

    const stdEval = ev.ok
      ? designEvalToStandard(ev.data, problemTitle, problemDescription, components, connections)
      : null
    let t = Date.now()
    const transcript = [
      { speaker: 'interviewer', text: 'System design — walk me through your architecture on the canvas.', timestamp: t, questionIndex: 0 },
    ]
    t += 500
    transcript.push({ speaker: 'interviewer', text: problemTitle, timestamp: t, questionIndex: 1 })
    t += 500
    transcript.push({ speaker: 'candidate', text: `[Design diagram: ${components.length} components, ${connections.length} connections]`, timestamp: t, questionIndex: 1 })

    const evaluations = stdEval ? [stdEval] : []
    const avg = stdEval ? avgScore(stdEval) : null
    const gates = scoreQuestionGates(avg, persona, !!stdEval, 'system-design')
    const questions = [{
      qi: 1,
      question: problemTitle,
      answer: '[design diagram]',
      persona,
      eval: stdEval,
      avg,
      genMs: 0,
      evalMs: ev.ms,
      gates,
      bandOk: gates.bandOk,
      g3Relevance: gates.g3Relevance,
    }]

    const liveTranscriptWords = synthWords(transcript)
    await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, liveTranscriptWords, status: 'in_progress' }, { stage: 'interview', step: 'patch-pre-feedback' })
    return { sessionId, config, transcript, evaluations, questions, liveTranscriptWords }
  }

  async function runFeedback(iv) {
    const planned = plannedCountForHarness(iv)
    const body = {
      config: iv.config, transcript: iv.transcript, evaluations: iv.evaluations,
      speechMetrics: [], sessionId: iv.sessionId,
      plannedQuestionCount: planned, answeredCount: iv.evaluations.length,
      endReason: 'user_ended',
    }
    let fb = await api('POST', '/api/generate-feedback', body, {
      stage: 'feedback',
      step: 'generate-feedback',
      meta: (r) => ({
        pathwayPlanStatus: r.data?.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan')?.status ?? null,
        overallScore: r.data?.overall_score ?? null,
      }),
    })
    // Retry once on a 5xx — under the matrix's concurrency a few Vercel function
    // instances crash on the heavy ~22s feedback call (instance-level, not a handled
    // error); the retry lands on a healthy instance. Mirrors the generate-question
    // 5xx retry. Real users issue one feedback call and never create this concurrency.
    if (!fb.ok && (fb.status >= 500 || fb.status === 0)) {
      await sleep(3000)
      fb = await api('POST', '/api/generate-feedback', body, {
        stage: 'feedback',
        step: 'generate-feedback-retry',
        meta: (r) => ({
          pathwayPlanStatus: r.data?.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan')?.status ?? null,
          overallScore: r.data?.overall_score ?? null,
        }),
      })
    }
    const sideEffectOutcomes = fb.data?.sideEffectOutcomes ?? null
    if (fb.status === 202 || fb.data.status === 'in_progress') {
      for (let i = 0; i < 80; i++) {
        await sleep(3000)
        const sess = await api('GET', `/api/interviews/${iv.sessionId}?excludeTranscript=true`, undefined, {
          stage: 'feedback',
          step: 'poll-' + i,
          meta: (r) => ({ pollIndex: i, pollMax: 80, overallScore: r.data?.feedback?.overall_score ?? null }),
        })
        if (sess.data.feedback?.overall_score != null) { fb = { ok: true, data: sess.data.feedback }; break }
      }
    }
    if (fb.ok && fb.data.overall_score != null) {
      await api('PATCH', `/api/interviews/${iv.sessionId}`, {
        status: 'completed', transcript: iv.transcript, evaluations: iv.evaluations,
        liveTranscriptWords: iv.liveTranscriptWords, feedback: fb.data,
        completedAt: new Date().toISOString(), endReason: 'user_ended',
        answeredCount: iv.evaluations.length, plannedQuestionCount: planned,
      }, { stage: 'feedback', step: 'patch-completed' })
    }
    return { ...fb, sideEffectOutcomes }
  }

  async function runAnalysis(sessionId) {
    let start = await api('POST', '/api/analysis/start', { sessionId }, { stage: 'analysis', step: 'analysis-start' })
    if (start.status === 429) {
      await sleep(8000)
      start = await api('POST', '/api/analysis/start', { sessionId }, { stage: 'analysis', step: 'analysis-start-retry' })
    }
    if (start.status === 403) return { skipped: true, reason: '403' }
    if (start.status === 429) return { skipped: true, reason: '429' }
    for (let i = 0; i < 60; i++) {
      await sleep(3000)
      const r = await api('GET', `/api/analysis/${sessionId}`, undefined, {
        stage: 'analysis',
        step: 'analysis-poll',
        meta: (res) => ({
          pollIndex: i,
          pollMax: 60,
          analysisStatus: res.data?.status ?? null,
          timelineEvents: res.data?.timeline?.length ?? 0,
        }),
      })
      if (r.data.status === 'completed' || r.data.status === 'failed') return r
    }
    return { ok: false, timeout: true }
  }

  async function runPathway(sessionId) {
    let pathwayGenerationStatus = null
    const PATHWAY_POLL_MAX = 80
    for (let i = 0; i < PATHWAY_POLL_MAX; i++) {
      const sess = await api('GET', `/api/interviews/${sessionId}?excludeTranscript=true`, undefined, {
        stage: 'pathway',
        step: 'pathway-poll',
        meta: (res) => ({
          pollIndex: i,
          pollMax: PATHWAY_POLL_MAX,
          pathwayGenerationStatus: res.data?.pathwayGenerationStatus ?? null,
        }),
      })
      pathwayGenerationStatus = sess.data.pathwayGenerationStatus ?? null
      const st = pathwayGenerationStatus
      if (st === 'succeeded' || st === 'failed' || st === 'skipped') break
      if (i === 25 && st === 'pending') {
        await api('POST', '/api/learn/pathway/retry', { sessionId }, { stage: 'pathway', step: 'pathway-retry' })
      }
      await sleep(3000)
    }
    const pathway = await api('GET', `/api/learn/pathway?fromFeedback=${sessionId}`, undefined, {
      stage: 'pathway',
      step: 'pathway-get-plan',
      meta: (res) => ({
        pathwayGenerationStatus,
        planItems: res.data?.planItems?.length ?? 0,
      }),
    })
    return {
      ...pathway,
      pathwayGenerationStatus,
      data: { ...pathway.data, pathwayGenerationStatus },
    }
  }

  async function runDrill(sessionId, persona) {
    const list = await api('GET', '/api/learn/drill/questions?limit=20', undefined, { stage: 'drill', step: 'list-questions' })
    const mine = (list.data.questions || []).filter((q) => q.sessionId === sessionId)
    if (persona === 'strong' || !mine.length) return { weakCount: mine.length, skipped: true }
    const target = mine[0]
    await api('GET', `/api/learn/drill/context/question?sessionId=${target.sessionId}&questionIndex=${target.questionIndex}`, undefined, { stage: 'drill', step: 'get-context' })
    const improved = (ANSWERS.behavioral.strong + ' Quantified impact and ownership with a clear lesson learned.')
    const t0 = performance.now()
    let res
    let text = ''
    let failed = false
    try {
      res = await fetch('/api/learn/drill/evaluate', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sessionId: target.sessionId, questionIndex: target.questionIndex,
          question: target.question, originalAnswer: target.answer,
          originalScore: target.avgScore, newAnswer: improved, competency: target.competency,
        }),
      })
      text = await res.text()
    } catch (e) {
      failed = true
      text = String(e.message || e)
    }
    const ms = Math.round(performance.now() - t0)
    emitNetworkActivity('drill', 'evaluate-sse', 'POST', '/api/learn/drill/evaluate', failed ? null : res.status, ms, text, failed || !res.ok, {
      sseEvents: text.split('\n\n').length,
    })
    return { weakCount: mine.length, sseEvents: text.split('\n\n').length }
  }

  function summarizeTelemetryLocal() {
    const byStage = {}
    let pass = 0
    let warn = 0
    let fail = 0
    for (const t of telemetry) {
      byStage[t.stage] = byStage[t.stage] || { pass: 0, warn: 0, fail: 0, total: 0 }
      byStage[t.stage].total++
      byStage[t.stage][t.verdict]++
      if (t.verdict === 'pass') pass++
      else if (t.verdict === 'warn') warn++
      else fail++
    }
    return { total: telemetry.length, pass, warn, fail, byStage }
  }

  async function executeCell(run) {
    activityCtx.matrixKey = `${run.domain}/${run.depth}/${run.persona}`
    activityCtx.sessionId = null
    const entry = { runId: run.runId, matrixKey: activityCtx.matrixKey, pass: true, stages: {}, questions: [] }
    let iv
    if (run.depth === 'coding') {
      iv = await runCodingInterview(run.domain, run.persona)
    } else if (run.depth === 'system-design') {
      iv = await runDesignInterview(run.domain, run.persona)
    } else {
      iv = await runInterview(run.domain, run.depth, run.persona)
    }
    entry.sessionId = iv.sessionId
    entry.questions = iv.questions
    entry.stages.interview = { pass: iv.questions.every((q) => q.eval) }
    entry.gates = {
      g1Pipeline: iv.questions.every((q) => q.gates?.g1Pipeline !== false),
      g2Separation: run.persona === 'weak'
        ? iv.questions.every((q) => q.gates?.g2Separation !== false)
        : null,
      g3Relevance: run.persona === 'strong'
        ? iv.questions.filter((q) => q.g3Relevance != null).every((q) => q.g3Relevance === true)
        : null,
    }
    for (const q of iv.questions) {
      if (!q.bandOk) entry.pass = false
    }

    const fb = await runFeedback(iv)
    const pathwayPlanOutcome = fb.sideEffectOutcomes?.find((o) => o.name === 'pathwayPlan') ?? null
    entry.stages.feedback = {
      pass: fb.ok && fb.data?.overall_score != null,
      score: fb.data?.overall_score,
      sideEffectOutcomes: fb.sideEffectOutcomes,
      pathwayPlanOutcome,
    }
    if (!entry.stages.feedback.pass) entry.pass = false

    entry.stages.analysis = await runAnalysis(iv.sessionId)
    entry.stages.pathway = await runPathway(iv.sessionId)
    const pwStatus = entry.stages.pathway.pathwayGenerationStatus
    entry.stages.pathway.pass = pwStatus === 'succeeded' || pwStatus === 'skipped'
    if (!entry.stages.pathway.pass && pwStatus !== 'failed') entry.pass = false
    entry.stages.drill = await runDrill(iv.sessionId, run.persona)
    return { entry, evalRows: iv.questions.map((q) => ({ run: entry.matrixKey, q: q.qi + 1, persona: run.persona, ...q })) }
  }

  async function runMatrix() {
    document.title = 'QA_MATRIX_RUNNING'
    const prior = window.__QA_PRIOR_REPORT__ || null
    runReportId = REPORT_ID_PARAM || prior?.reportId || `qa-browser-${MODE}-${Date.now()}`
    if (!prior) telemetry.length = 0
    const allRuns = buildRuns()
    const capped = RUN_LIMIT > 0 ? allRuns.slice(0, RUN_LIMIT) : allRuns
    const matrixRuns = capped.slice(Math.max(0, CELL_OFFSET))
    log(`QA Matrix v${HARNESS_VERSION} — mode=${MODE} runs=${matrixRuns.length}/${capped.length} offset=${CELL_OFFSET} questions=${Q_LIMIT} duration=${DURATION}min experience=${MATRIX_EXPERIENCE} cellRetry=${CELL_RETRY}`)
    const results = prior?.runs ? prior.runs.slice() : []
    const evalRows = prior?.evaluationRows ? prior.evaluationRows.slice() : []
    let done = CELL_OFFSET

    for (const run of matrixRuns) {
      log(`[${++done}/${capped.length}] ${run.runId} …`)
      let entry = null
      let attempt = 0
      while (attempt <= CELL_RETRY) {
        try {
          const out = await executeCell(run)
          entry = out.entry
          evalRows.push(...out.evalRows)
          break
        } catch (err) {
          if (err && err.name === 'QuotaExceeded') {
            entry = { runId: run.runId, matrixKey: `${run.domain}/${run.depth}/${run.persona}`, pass: false, error: err.message, quotaAborted: true }
            log(`  QUOTA STOP: ${err.message}`)
            break
          }
          attempt++
          if (attempt <= CELL_RETRY) {
            log(`  retry ${attempt}/${CELL_RETRY} after: ${err.message || err}`)
            await sleep(2000)
            continue
          }
          entry = { runId: run.runId, matrixKey: `${run.domain}/${run.depth}/${run.persona}`, pass: false, error: String(err.message || err) }
          log(`  FAIL: ${entry.error}`)
        }
      }
      if (entry) {
        const idx = results.findIndex((r) => r.runId === entry.runId)
        if (idx >= 0) results[idx] = entry
        else results.push(entry)
        log(`  ${entry.pass ? 'PASS' : 'FAIL'} session=${entry.sessionId || 'n/a'}`)
      }
      if (quotaAborted) {
        log('Quota exceeded — aborting remaining cells')
        break
      }
    }

    const passed = results.filter((r) => r.pass).length
    const telemetrySummary = summarizeTelemetryLocal()
    const report = {
      reportId: runReportId,
      harnessVersion: HARNESS_VERSION,
      mode: MODE,
      matrixExperience: MATRIX_EXPERIENCE,
      totalRuns: results.length, passedRuns: passed,
      passRate: results.length ? passed / results.length : 0,
      evaluationRows: evalRows, runs: results,
      telemetry: [...(prior?.telemetry ?? []), ...telemetry],
      telemetrySummary,
      resume: { offset: results.length, quotaAborted, completedCells: results.map((r) => r.runId) },
      finishedAt: new Date().toISOString(),
    }
    pre.textContent = JSON.stringify(report, null, 2)
    document.title = 'QA_MATRIX_DONE'
    log(`\nDone: ${passed}/${results.length} passed (${(report.passRate*100).toFixed(1)}%)`)
    window.__QA_REPORT__ = report
    try {
      localStorage.setItem('qa_matrix_report', JSON.stringify(report))
      console.log('QA_REPORT_START')
      console.log(JSON.stringify(report))
      console.log('QA_REPORT_END')
    } catch (e) {
      console.log('QA_REPORT_ERROR', String(e))
    }
    return report
  }

  // UI + autostart (Playwright injects this script — hash params alone do nothing in a normal browser)
  mountUi()
  if (AUTOSTART || !document.getElementById('qa-start')) {
    runMatrix().catch((e) => { document.title = 'QA_MATRIX_ERROR'; log('Fatal: ' + e.message) })
  } else {
    const btn = document.createElement('button')
    btn.id = 'qa-start'
    btn.textContent = 'Start matrix'
    btn.onclick = () => runMatrix()
    document.body.appendChild(btn)
  }
})()
