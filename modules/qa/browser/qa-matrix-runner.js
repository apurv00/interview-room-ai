location.hash='mode=full&questions=3&autostart=1';
;(async function qaMatrixRunner() {
  const HARNESS_VERSION = '2.1.0'
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

  const DOMAINS = ['frontend','backend','sdet','data-science','pm','design','business','general']
  const DEPTHS = [
    { slug: 'behavioral' },
    { slug: 'technical' },
    { slug: 'case-study', domains: ['pm','business','data-science','design','general'] },
    { slug: 'system-design', domains: ['backend','frontend','data-science','sdet','general'] },
    { slug: 'coding', domains: ['backend','frontend','data-science','sdet'] },
  ]
  const SMOKE = [
    ['pm','behavioral'],['backend','technical'],['pm','case-study'],
    ['backend','system-design'],['frontend','coding'],['design','technical'],
  ]
  const PERSONAS = ['strong','weak']
  const ANSWERS = {
    behavioral:{strong:'At Acme I led a cross-functional launch that cut checkout drop-off by 38% in six weeks with clear metrics and ownership.',weak:'I worked on a project with my team and we improved things. It went well.'},
    technical:{strong:'We migrated to event-driven microservices on Kafka, cut p99 from 800ms to 120ms, with DLQs and phased rollout.',weak:'We moved to microservices and used Kafka. It was faster.'},
    'case-study':{strong:'Goal 15% MAU growth: sized market, prioritized referral + onboarding, expected +3.2pp conversion.',weak:'I would grow users with marketing and improve the product.'},
    'system-design':{strong:'10M DAU, CDN, stateless API, Postgres + replicas, Redis cache, SQS workers, 99.9% SLA trade-offs documented.',weak:'Load balancer, database, cache, scale horizontally.'},
    coding:{strong:'Hash map O(n) time O(k) space, handle empty input and edge cases, sort by frequency.',weak:'Loop and count with a hash map probably.'},
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

  function applicable(domain, depth) {
    const d = DEPTHS.find((x) => x.slug === depth)
    if (!d) return false
    return !d.domains || d.domains.includes(domain)
  }

  const STRONG_VARIANTS = {
    behavioral: [
      { kw: ['conflict','disagree','tension','pushback','push back'], ans: 'Two senior engineers blocked a release over an architecture choice. I ran a 45-minute decision review with explicit criteria, surfaced the cost of delay, and chose the reversible option. We shipped on time and revisited the call in six weeks with data.' },
      { kw: ['fail','failure','mistake','setback','regret'], ans: 'I owned a migration that dropped 4% of payment events on day one. I rolled back in 18 minutes, ran a blameless postmortem, added contract tests at the boundary, and led the second attempt two weeks later with zero data loss.' },
      { kw: ['influence','persuade','convince','stakeholder','cross-functional','without authority'], ans: 'I needed legal, security, and design aligned on a new consent flow without formal authority. I built a one-page tradeoff doc, ran 1:1s before the group meeting, and we shipped a single agreed design in nine days versus the usual six weeks.' },
      { kw: ['mentor','coach','junior','teach','grow someone'], ans: 'I mentored a junior engineer stuck in code review. We paired weekly for eight weeks, codified the team review rubric, and her PR turnaround dropped from four days to under one. She now runs onboarding for new hires.' },
      { kw: ['feedback','criticism','difficult conversation','tough conversation'], ans: 'A peer was giving code reviews that demoralized the team. I gave direct private feedback with two specific examples, suggested a phrasing change, and offered to pair on the next review. The next team survey showed a measurable shift.' },
      { kw: ['priorit','tradeoff','say no','decide'], ans: 'My team had eleven inbound requests in Q3. I aligned with the PM on three business outcomes, scored each request against them, said no to six, and we hit all three outcomes versus missing two the prior quarter.' },
      { kw: [], ans: 'At Acme I led a cross-functional launch that cut checkout drop-off by 38% in six weeks. I ran weekly experiments with engineering and design, scoped a phased rollout behind feature flags, and owned the metrics review to leadership.' },
    ],
    technical: [
      { kw: ['frontend','react','css','ui','render','browser','client','web vitals','lcp','hydration','bundle'], ans: 'I cut LCP from 4.2s to 1.8s on our marketing site. I code-split routes, deferred third-party scripts, inlined critical CSS, and switched to next/image. Lighthouse mobile rose from 42 to 89 and organic conversion climbed 11%.' },
      { kw: ['test','automation','sdet','qa','coverage','flaky','flake','e2e','integration test'], ans: 'Our e2e suite was 12% flaky and blocking deploys. I isolated shared DB state per worker, added deterministic seeding, and parallelized to four workers. Flake rate dropped to 1.5%, suite time from 38 to 11 minutes, deploy throughput doubled.' },
      { kw: ['data pipeline','ml','etl','dbt','airflow','analytics','feature store','model serving'], ans: 'I rebuilt our analytics pipeline on Kafka and Flink with schema validation and per-event idempotency. End-to-end latency dropped from six hours to twelve minutes, late-arriving events handled correctly, and downstream dashboards stopped diverging from source.' },
      { kw: ['design system','ux','prototype','accessibility','a11y','wcag'], ans: 'I led a design system rollout across 14 product surfaces. Defined tokens, built primitives in Figma and code with WCAG AA contrast, and ran a six-week migration sprint. Component reuse went from 23% to 78% and design QA tickets dropped 60%.' },
      { kw: ['product','roadmap','prioritization','tech debt','velocity'], ans: 'I owned the technical roadmap for our checkout team. Quantified tech debt cost at 22% of velocity, negotiated 30% capacity allocation with leadership, paid down the top three items in two quarters, and team throughput rose 28%.' },
      { kw: ['rest api','public api','api design','url shortener','endpoint','pagination','openapi','swagger'], ans: 'For a public REST API: resource-oriented URIs, semantic verbs, consistent error envelope with code plus retryable hint, cursor-based pagination over offset, versioning via URL path prefix, rate limits per key returned as response headers, deprecation policy with six-month overlap and Sunset header, and OpenAPI spec as source of truth for SDK generation.' },
      { kw: [], ans: 'We migrated a payments service from a monolith to event-driven microservices on Kafka. Cut p99 from 800ms to 120ms with a phased rollout, dual-write window, DLQs, and replay tooling. Zero data loss across 14 billion events.' },
    ],
    'case-study': [
      { kw: ['design','ux','user research','usability','flow','interaction'], ans: 'For a B2B onboarding redesign: I would map the current funnel, identify the two highest-drop steps, prototype three alternatives, run unmoderated tests with eight users per variant, and ship the winner behind a 50/50 flag. Success: time-to-first-value under four minutes.' },
      { kw: ['pricing','monetiz','revenue','business model','plan','tier'], ans: 'For a pricing rework: I would segment customers by current ARPU and usage, hypothesize three packaging variants, model revenue impact at conservative, realistic, and optimistic conversion, run a four-week price test on new signups, and gate rollout on a 95% CI on incremental revenue.' },
      { kw: ['market','expansion','launch','segment','tam','geography','new product'], ans: 'For entering a new market: I would size the TAM bottom-up from comparable wedges, identify three beachhead segments, validate willingness-to-pay with 15 customer interviews, and gate a pilot on signed LOIs from five lighthouse accounts before building.' },
      { kw: ['data','analysis','model','forecast','hypothesis','metric drop','funnel'], ans: 'For diagnosing a metric drop: I would decompose the funnel by segment, isolate the days the change appeared, cross-reference deploys and external events, form two or three falsifiable hypotheses, and run targeted analyses to confirm or rule out each before recommending action.' },
      { kw: [], ans: 'Goal: 15% MAU growth in two quarters. I sized the market, prioritized referral and onboarding as highest-leverage levers, modeled +3.2pp impact at the activation step, and would gate the rollout on a four-week holdout with a pre-registered primary metric.' },
    ],
    'system-design': [
      { kw: ['chat','message','notification','real-time','live','presence','websocket'], ans: 'For chat at 5M concurrent: WebSocket fanout via stateful gateway, Redis pubsub for cross-region, message store in Cassandra with per-room partitioning, idempotent delivery via dedupe key, and degraded mode to long-poll on gateway failure.' },
      { kw: ['payment','transaction','ledger','consistency','money','billing'], ans: 'For a payment ledger: double-entry append-only on Postgres with strict serializable transactions, idempotency key on every write, async settlement to a separate ledger, daily reconciliation against the processor, and a kill switch that fails closed on integrity mismatch.' },
      { kw: ['feed','timeline','news','social','followers'], ans: 'For a social feed at 100M DAU: hybrid fanout — push for users under 10k followers, pull for high-follow accounts, ranked by a feature store served from Redis, with 90-second freshness target and per-user ranking cache invalidated on new follow.' },
      { kw: ['search','index','rank','elasticsearch','autocomplete'], ans: 'For search: ingestion via Kafka into an inverted index in Elasticsearch with rolling indexes, autocomplete from a trie in Redis, query-time ranking with a learned model, and a query log plus click feedback loop training a daily reranker.' },
      { kw: ['recommendation','ml inference','model serving','personalization'], ans: 'For ML inference at 50k rps: feature store in Redis with TTL, model served via Triton on GPU autoscale, request-time embedding lookup, prediction cache for hot items at five-minute TTL, and a shadow-traffic A/B path to evaluate new models without user impact.' },
      { kw: ['video','stream','live stream','vod','transcod'], ans: 'For live streaming: ingest via RTMP to a transcoding fleet on GPU, HLS chunks to S3 and CDN, viewer count via Redis sorted set, chat on a separate WS path, with adaptive bitrate ladder and per-region origin failover.' },
      { kw: ['test framework','automated test','flaky','ci pipeline','test data','test isolation','parallel test','test runner architecture'], ans: 'For an e2e test framework at scale: per-worker isolated test data with namespaced records, deterministic seeding via per-run UUID prefix, parallel sharding by test file with a queue dispatcher, retry only on infra-flake error codes never on assertion failures, per-test artifacts (screenshot, HAR, logs) auto-uploaded on failure, and flake detection via passing-after-retry signal aggregated to a dashboard.' },
      { kw: [], ans: 'For 10M DAU: CDN at the edge, stateless API behind an ALB, primary Postgres with two read replicas, Redis for hot cache, SQS for async work, observability via OpenTelemetry, and a 99.9% SLA with documented trade-offs against single-region failure.' },
    ],
    coding: [
      { kw: ['tree','binary tree','bst','traversal','depth','height','ancestor'], ans: 'Iterative DFS with explicit stack, O(n) time, O(h) space where h is tree height. Handle null root, single node, and skewed tree edge cases. For BST problems exploit ordered traversal; for general trees prefer post-order when the result depends on subtrees.' },
      { kw: ['graph','bfs','dfs','shortest','cycle','topological','dijkstra'], ans: 'BFS with a visited set for unweighted shortest path, O(V+E). For cycle detection in directed graphs use DFS with three-color (white, gray, black) marking. Outer loop over all nodes to handle disconnected components. Edge cases: self-loops and parallel edges.' },
      { kw: ['dp','dynamic programming','memoize','subproblem','optimal substructure'], ans: 'Top-down with memoization first to verify the recurrence, then convert to bottom-up if space matters. State: input dimensions. Transition: enumerate choices at each step. Base case: smallest valid subproblem. Watch for off-by-one and integer overflow.' },
      { kw: ['string','substring','palindrome','anagram','subsequence'], ans: 'Two-pointer for palindrome check at O(n) and O(1) space. For longest palindromic substring, expand-around-center at O(n^2)/O(1) beats DP at O(n^2)/O(n^2). Anagram: frequency array of size 26 for lowercase or hash map for unicode. Handle empty string and case sensitivity.' },
      { kw: ['array','sort','two pointer','sliding window','subarray'], ans: 'Sliding window for contiguous-subarray problems with a monotone condition, O(n)/O(1). Two-pointer on sorted array for pair-sum. For kth-smallest prefer quickselect at O(n) average over full sort. Handle empty array and single-element edge cases.' },
      { kw: ['linked list','reverse','cycle','merge'], ans: 'Reverse in place with three pointers (prev, curr, next), O(n)/O(1). Cycle detection via tortoise and hare, then find entry point. Merge sorted lists with a dummy head to simplify edge cases. Watch for null head and single-node list.' },
      { kw: ['stack','queue','monotonic','parenthes','bracket'], ans: 'Monotonic stack for next-greater-element problems, O(n) amortized. For parentheses validity, push opens and pop-and-match closes; check stack empty at the end. Use a deque for sliding-window max in O(n). Edge cases: empty input and unmatched closes.' },
      { kw: ['pandas','dataframe','groupby','aggregate','event-level','event level','sql query','watch_time'], ans: 'For event-level analysis on a media DataFrame: validate schema and null rates first, partition by user_id, compute per-user aggregates with a SQL window function or pandas groupby, and surface the top-N via a materialized view. For 100M-plus events, push the predicate down at read time and keep only projected columns in memory.' },
      { kw: ['autocomplete','debounce','react component','props','event handler','usestate','usememo','controlled input'], ans: 'For an autocomplete component: controlled input with value and onChange props, query debounced at 300ms via a useRef timer to avoid stale closures, results cached by query in a Map ref, keyboard nav with aria-activedescendant, and abort the in-flight fetch on each new keystroke. Memoize the rendered list to skip re-renders on parent updates.' },
      { kw: ['lru','test runner','parameterized','test harness','implement an','implement a tiny','design a tiny','register test','cache implementation'], ans: 'For an LRU cache: doubly linked list plus hash map, O(1) get and put. Hash map maps key to node pointer, list maintains recency. On get, splice the node to head; on put, evict tail if at capacity. Edge cases: capacity zero, update existing key by moving the node rather than allocating.' },
      { kw: [], ans: 'Hash map for O(n) lookup versus O(n^2) brute force, trading O(k) space for time. Iterate once collecting counts, second pass to identify the result. Handle empty input, duplicates, and tie-breaking explicitly. Sort by count descending if order is required.' },
    ],
  }

  function pickStrong(question, depth) {
    const variants = STRONG_VARIANTS[depth] || STRONG_VARIANTS.behavioral
    const q = (question || '').toLowerCase()
    for (const v of variants) {
      if (v.kw.length && v.kw.some((k) => q.includes(k))) return v.ans
    }
    return variants[variants.length - 1].ans
  }

  function buildAnswer(question, depth, persona) {
    if (persona === 'strong') return pickStrong(question, depth)
    return (ANSWERS[depth] || ANSWERS.behavioral).weak
  }

  function buildRuns() {
    const runs = []
    const cells = MODE === 'smoke' ? SMOKE.map(([domain, depth]) => ({ domain, depth }))
      : DOMAINS.flatMap((domain) => DEPTHS.map((d) => ({ domain, depth: d.slug }))).filter((c) => applicable(c.domain, c.depth))
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
    const config = { role: domain, interviewType: depth, experience: '3-6', duration: DURATION, privacyMode: true }
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
      const gq = await api('POST', '/api/generate-question', {
        config, questionIndex: qi, previousQA: transcript, sessionId,
        performanceSignal: persona === 'strong' ? 'on_track' : 'struggling',
      }, {
        stage: 'interview',
        step: 'generate-question',
        meta: (r) => ({ questionIndex: qi, question: r.data.question || '' }),
      })
      const question = gq.data.question || ''
      const answer = buildAnswer(question, depth, persona)
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
      questions.push({
        qi, question, answer, persona,
        eval: ev.ok ? ev.data : null,
        avg: ev.ok ? avgScore(ev.data) : null,
        genMs: gq.ms, evalMs: ev.ms,
        bandOk: ev.ok ? (persona === 'strong' ? avgScore(ev.data) >= 60 : avgScore(ev.data) <= 55) : false,
      })
    }

    const liveTranscriptWords = synthWords(transcript)
    await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, liveTranscriptWords, status: 'in_progress' }, { stage: 'interview', step: 'patch-pre-feedback' })
    return { sessionId, config, transcript, evaluations, questions, liveTranscriptWords }
  }

  async function runFeedback(iv) {
    const body = {
      config: iv.config, transcript: iv.transcript, evaluations: iv.evaluations,
      speechMetrics: [], sessionId: iv.sessionId,
      plannedQuestionCount: iv.questions.length, answeredCount: iv.evaluations.length,
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
    const sideEffectOutcomes = fb.data?.sideEffectOutcomes ?? null
    if (fb.status === 202 || fb.data.status === 'in_progress') {
      for (let i = 0; i < 40; i++) {
        await sleep(3000)
        const sess = await api('GET', `/api/interviews/${iv.sessionId}?excludeTranscript=true`, undefined, {
          stage: 'feedback',
          step: 'poll-' + i,
          meta: (r) => ({ pollIndex: i, pollMax: 40, overallScore: r.data?.feedback?.overall_score ?? null }),
        })
        if (sess.data.feedback?.overall_score != null) { fb = { ok: true, data: sess.data.feedback }; break }
      }
    }
    if (fb.ok && fb.data.overall_score != null) {
      await api('PATCH', `/api/interviews/${iv.sessionId}`, {
        status: 'completed', transcript: iv.transcript, evaluations: iv.evaluations,
        liveTranscriptWords: iv.liveTranscriptWords, feedback: fb.data,
        completedAt: new Date().toISOString(), endReason: 'user_ended',
        answeredCount: iv.evaluations.length, plannedQuestionCount: iv.questions.length,
      }, { stage: 'feedback', step: 'patch-completed' })
    }
    return { ...fb, sideEffectOutcomes }
  }

  async function runAnalysis(sessionId) {
    const start = await api('POST', '/api/analysis/start', { sessionId }, { stage: 'analysis', step: 'analysis-start' })
    if (start.status === 403) return { skipped: true, reason: '403' }
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
    for (let i = 0; i < 40; i++) {
      const sess = await api('GET', `/api/interviews/${sessionId}?excludeTranscript=true`, undefined, {
        stage: 'pathway',
        step: 'pathway-poll',
        meta: (res) => ({
          pollIndex: i,
          pollMax: 40,
          pathwayGenerationStatus: res.data?.pathwayGenerationStatus ?? null,
        }),
      })
      pathwayGenerationStatus = sess.data.pathwayGenerationStatus ?? null
      const st = pathwayGenerationStatus
      if (st === 'succeeded' || st === 'failed' || st === 'skipped') break
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

  async function runMatrix() {
    document.title = 'QA_MATRIX_RUNNING'
    runReportId = `qa-browser-${MODE}-${Date.now()}`
    telemetry.length = 0
    const runs = buildRuns()
    const matrixRuns = RUN_LIMIT > 0 ? runs.slice(0, RUN_LIMIT) : runs
    log(`QA Matrix v${HARNESS_VERSION} — mode=${MODE} runs=${matrixRuns.length} questions=${Q_LIMIT} duration=${DURATION}min`)
    const results = []
    const evalRows = []
    let done = 0

    for (const run of matrixRuns) {
      log(`[${++done}/${matrixRuns.length}] ${run.runId} …`)
      activityCtx.matrixKey = `${run.domain}/${run.depth}/${run.persona}`
      activityCtx.sessionId = null
      const entry = { runId: run.runId, matrixKey: activityCtx.matrixKey, pass: true, stages: {}, questions: [] }
      try {
        const iv = await runInterview(run.domain, run.depth, run.persona)
        entry.sessionId = iv.sessionId
        entry.questions = iv.questions
        for (const q of iv.questions) {
          evalRows.push({ run: entry.matrixKey, q: q.qi + 1, persona: run.persona, ...q })
          if (!q.bandOk) entry.pass = false
        }
        entry.stages.interview = { pass: iv.questions.every((q) => q.eval) }

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
      } catch (err) {
        entry.pass = false
        entry.error = String(err.message || err)
        log(`  FAIL: ${entry.error}`)
      }
      results.push(entry)
      log(`  ${entry.pass ? 'PASS' : 'FAIL'} session=${entry.sessionId || 'n/a'}`)
    }

    const passed = results.filter((r) => r.pass).length
    const telemetrySummary = summarizeTelemetryLocal()
    const report = {
      reportId: runReportId,
      harnessVersion: HARNESS_VERSION,
      mode: MODE, totalRuns: results.length, passedRuns: passed,
      passRate: results.length ? passed / results.length : 0,
      evaluationRows: evalRows, runs: results,
      telemetry,
      telemetrySummary,
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
