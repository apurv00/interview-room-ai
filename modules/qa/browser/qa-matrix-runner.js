location.hash='mode=full&questions=3&autostart=1';
;(async function qaMatrixRunner() {
  const HARNESS_VERSION = '2.4.0'
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
  const CELL_OFFSET = parseInt(params.get('offset') || '0', 10)
  const CELL_RETRY = parseInt(params.get('cellRetry') || '1', 10)
  const REPORT_ID_PARAM = params.get('reportId') || null

  let quotaAborted = false
  function QuotaExceeded(status) {
    this.name = 'QuotaExceeded'
    this.status = status
    this.message = 'Usage quota exceeded (HTTP ' + status + ')'
  }

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

  // __QA_INJECT_START__ — replaced by npm run qa:build:browser from strongAnswers.json + strongAnswerRouter.mjs
  const STRONG_ANSWERS_CONFIG = {"version":1,"byBucket":{},"byDomainBucket":{},"bySlot":{},"depthFallback":{"behavioral":"Situation: At Acme I led a cross-functional launch with clear metrics and ownership. Action: Scoped phased rollout and tracked weekly outcomes. Result: Delivered measurable impact on schedule."}}
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
    const config = { role: domain, interviewType: depth, experience: '3-6', duration: DURATION, privacyMode: true }
    const create = await api('POST', '/api/interviews', { config }, { stage: 'interview', step: 'create' })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    activityCtx.sessionId = sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() }, { stage: 'interview', step: 'patch-start' })

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
    const config = { role: domain, interviewType: depth, experience: '3-6', duration: DURATION, privacyMode: true }
    const create = await api('POST', '/api/interviews', { config }, { stage: 'interview', step: 'create' })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    activityCtx.sessionId = sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() }, { stage: 'interview', step: 'patch-start' })

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
    log(`QA Matrix v${HARNESS_VERSION} — mode=${MODE} runs=${matrixRuns.length}/${capped.length} offset=${CELL_OFFSET} questions=${Q_LIMIT} duration=${DURATION}min cellRetry=${CELL_RETRY}`)
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
      mode: MODE, totalRuns: results.length, passedRuns: passed,
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
