/**
 * In-page QA matrix runner — runs on interviewprep.guru using the logged-in browser session.
 * No cookie export. No Playwright. Inject via public/qa-matrix-runner.html or blob loader.
 *
 * Params (hash): #mode=full&questions=3&autostart=1
 */
;(async function qaMatrixRunner() {
  const params = new URLSearchParams((location.hash.replace(/^#/, '') || location.search).replace(/^\?/, ''))
  const MODE = params.get('mode') || 'smoke'
  const Q_LIMIT = parseInt(params.get('questions') || '3', 10)
  const AUTOSTART = params.get('autostart') === '1'
  const DURATION = 10

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

  const logEl = document.getElementById('qa-log') || (() => {
    const d = document.createElement('div')
    d.id = 'qa-log'
    d.style.cssText = 'font:13px monospace;padding:12px;white-space:pre-wrap;max-height:40vh;overflow:auto;background:#111;color:#0f0'
    document.body.prepend(d)
    return d
  })()
  const pre = document.getElementById('qa-result') || (() => {
    const p = document.createElement('pre')
    p.id = 'qa-result'
    p.style.cssText = 'font:11px monospace;padding:12px;white-space:pre-wrap;word-break:break-all'
    document.body.appendChild(p)
    return p
  })()

  const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; console.log('[QA]', m) }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function applicable(domain, depth) {
    const d = DEPTHS.find((x) => x.slug === depth)
    if (!d) return false
    return !d.domains || d.domains.includes(domain)
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

  async function api(method, route, body) {
    const t0 = performance.now()
    const res = await fetch(route, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text.slice(0, 500) } }
    return { ok: res.ok, status: res.status, data, ms: Math.round(performance.now() - t0) }
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
    const create = await api('POST', '/api/interviews', { config })
    if (!create.ok || !create.data.sessionId) throw new Error('create failed: ' + create.status)
    const sessionId = create.data.sessionId
    await api('PATCH', `/api/interviews/${sessionId}`, { status: 'in_progress', startedAt: new Date().toISOString() })

    const transcript = []
    const evaluations = []
    const questions = []
    let t = Date.now()

    for (let qi = 0; qi < Q_LIMIT; qi++) {
      const gq = await api('POST', '/api/generate-question', {
        config, questionIndex: qi, previousQA: transcript, sessionId,
        performanceSignal: persona === 'strong' ? 'on_track' : 'struggling',
      })
      const question = gq.data.question || ''
      const base = (ANSWERS[depth] || ANSWERS.behavioral)[persona]
      const answer = (question.length > 80 ? `Regarding "${question.slice(0,80)}...", ` : '') + base
      transcript.push({ speaker: 'interviewer', text: question, timestamp: t, questionIndex: qi })
      t += 500
      transcript.push({ speaker: 'candidate', text: answer, timestamp: t, questionIndex: qi })
      t += 2000
      const ev = await api('POST', '/api/evaluate-answer', { config, question, answer, questionIndex: qi, sessionId })
      if (ev.ok) evaluations.push(ev.data)
      await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, status: 'in_progress' })
      questions.push({
        qi, question, answer, persona,
        eval: ev.ok ? ev.data : null,
        avg: ev.ok ? avgScore(ev.data) : null,
        genMs: gq.ms, evalMs: ev.ms,
        bandOk: ev.ok ? (persona === 'strong' ? avgScore(ev.data) >= 60 : avgScore(ev.data) <= 55) : false,
      })
    }

    const liveTranscriptWords = synthWords(transcript)
    await api('PATCH', `/api/interviews/${sessionId}`, { transcript, evaluations, liveTranscriptWords, status: 'in_progress' })
    return { sessionId, config, transcript, evaluations, questions, liveTranscriptWords }
  }

  async function runFeedback(iv) {
    const body = {
      config: iv.config, transcript: iv.transcript, evaluations: iv.evaluations,
      speechMetrics: [], sessionId: iv.sessionId,
      plannedQuestionCount: iv.questions.length, answeredCount: iv.evaluations.length,
      endReason: 'user_ended',
    }
    let fb = await api('POST', '/api/generate-feedback', body)
    if (fb.status === 202 || fb.data.status === 'in_progress') {
      for (let i = 0; i < 40; i++) {
        await sleep(3000)
        const sess = await api('GET', `/api/interviews/${iv.sessionId}?excludeTranscript=true`)
        if (sess.data.feedback?.overall_score != null) { fb = { ok: true, data: sess.data.feedback }; break }
      }
    }
    if (fb.ok && fb.data.overall_score != null) {
      await api('PATCH', `/api/interviews/${iv.sessionId}`, {
        status: 'completed', transcript: iv.transcript, evaluations: iv.evaluations,
        liveTranscriptWords: iv.liveTranscriptWords, feedback: fb.data,
        completedAt: new Date().toISOString(), endReason: 'user_ended',
        answeredCount: iv.evaluations.length, plannedQuestionCount: iv.questions.length,
      })
    }
    return fb
  }

  async function runAnalysis(sessionId) {
    const start = await api('POST', '/api/analysis/start', { sessionId })
    if (start.status === 403) return { skipped: true, reason: '403' }
    for (let i = 0; i < 60; i++) {
      await sleep(3000)
      const r = await api('GET', `/api/analysis/${sessionId}`)
      if (r.data.status === 'completed' || r.data.status === 'failed') return r
    }
    return { ok: false, timeout: true }
  }

  async function runPathway(sessionId) {
    for (let i = 0; i < 40; i++) {
      const sess = await api('GET', `/api/interviews/${sessionId}?excludeTranscript=true`)
      const st = sess.data.pathwayGenerationStatus
      if (st === 'completed' || st === 'failed' || st === undefined) break
      await sleep(3000)
    }
    return api('GET', `/api/learn/pathway?fromFeedback=${sessionId}`)
  }

  async function runDrill(sessionId, persona) {
    const list = await api('GET', '/api/learn/drill/questions?limit=20')
    const mine = (list.data.questions || []).filter((q) => q.sessionId === sessionId)
    if (persona === 'strong' || !mine.length) return { weakCount: mine.length, skipped: true }
    const target = mine[0]
    await api('GET', `/api/learn/drill/context/question?sessionId=${target.sessionId}&questionIndex=${target.questionIndex}`)
    const improved = (ANSWERS.behavioral.strong + ' Quantified impact and ownership with a clear lesson learned.')
    const res = await fetch('/api/learn/drill/evaluate', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        sessionId: target.sessionId, questionIndex: target.questionIndex,
        question: target.question, originalAnswer: target.answer,
        originalScore: target.avgScore, newAnswer: improved, competency: target.competency,
      }),
    })
    const text = await res.text()
    return { weakCount: mine.length, sseEvents: text.split('\n\n').length }
  }

  async function runMatrix() {
    document.title = 'QA_MATRIX_RUNNING'
    const runs = buildRuns()
    log(`QA Matrix — mode=${MODE} runs=${runs.length} questions=${Q_LIMIT}`)
    const results = []
    const evalRows = []
    const routeFreq = {}
    let done = 0

    for (const run of runs) {
      log(`[${++done}/${runs.length}] ${run.runId} …`)
      const entry = { runId: run.runId, matrixKey: `${run.domain}/${run.depth}/${run.persona}`, pass: true, stages: {}, questions: [] }
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
        entry.stages.feedback = { pass: fb.ok && fb.data?.overall_score != null, score: fb.data?.overall_score }
        if (!entry.stages.feedback.pass) entry.pass = false

        entry.stages.analysis = await runAnalysis(iv.sessionId)
        entry.stages.pathway = await runPathway(iv.sessionId)
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
    const report = {
      reportId: `qa-browser-${MODE}-${Date.now()}`,
      mode: MODE, totalRuns: results.length, passedRuns: passed,
      passRate: results.length ? passed / results.length : 0,
      evaluationRows: evalRows, runs: results,
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

  // UI
  document.body.innerHTML = '<h1 style="font:16px sans-serif;padding:12px">QA Matrix Runner (browser session)</h1>'
  document.body.style.background = '#fff'
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
