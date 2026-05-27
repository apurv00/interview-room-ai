#!/usr/bin/env node
/**
 * QA harness STRONG_VARIANTS coverage check.
 *
 * Runs the same keyword-routing logic that `pickStrong()` in
 * `modules/qa/browser/qa-matrix-runner.js` uses, against the actual
 * strong-persona questions from a real matrix run.
 *
 * Reports per-cell which variant each question matched, flags any cell
 * where every question fell to the depth default (red zone), and gives
 * an overall hit-rate.
 *
 * Use this after editing STRONG_VARIANTS to verify the new keywords
 * actually fire on production-generated questions before launching a
 * full overnight matrix.
 *
 * Usage:
 *   npm run qa:check:coverage                                # uses baseline 1779529900005.json
 *   npm run qa:check:coverage -- path/to/qa-browser-*.json   # any prior run
 *
 * IMPORTANT: keep STRONG_VARIANTS below in sync with
 * `modules/qa/browser/qa-matrix-runner.js`. Labels here are arbitrary
 * (only used for the report); keywords must match the runner exactly.
 */

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_JSON = 'modules/qa/output/qa-browser-full-1779529900005.json'
const jsonPath = process.argv[2] || DEFAULT_JSON

if (!fs.existsSync(jsonPath)) {
  console.error(`Report JSON not found: ${jsonPath}`)
  console.error('Pass a path as the first argument, or place the baseline at ' + DEFAULT_JSON)
  process.exit(1)
}

const STRONG_VARIANTS = {
  behavioral: [
    { kw: ['journey into product', 'product management and the kinds', 'first meaningful product project', 'role end to end'], label: 'PM-JOURNEY' },
    { kw: ['change a product decision', 'new data or user feedback', "wasn't working", 'original approach wasn'], label: 'PM-PIVOT' },
    { kw: ['disappointing one or more stakeholders', 'difficult prioritization call', 'prioritization call that disappointed'], label: 'PM-PRIOR-STAKE' },
    { kw: ['idea to launch with limited', 'limited time or resources', 'take a product from idea to launch'], label: 'PM-LAUNCH' },
    { kw: ['incomplete or conflicting data', 'product decision with incomplete', 'reason through it', 'keep the team aligned'], label: 'PM-AMBIGUITY' },
    { kw: ['senior executive who was skeptical', 'explain a product decision to a senior executive', 'won them over'], label: 'PM-EXEC' },
    { kw: ['owned a product outcome that went wrong', 'went wrong after launch', 'first 24 hours'], label: 'PM-FAILURE' },
    { kw: ['conflict','disagree','tension','pushback','push back'], label: 'CONFLICT' },
    { kw: ['fail','failure','mistake','setback','regret'], label: 'FAILURE' },
    { kw: ['influence','persuade','convince','cross-functional','without authority'], label: 'INFLUENCE' },
    { kw: ['mentor','coach','junior','teach','grow someone'], label: 'MENTOR' },
    { kw: ['feedback','criticism','difficult conversation','tough conversation'], label: 'FEEDBACK' },
    { kw: ['priorit','tradeoff','say no','decide'], label: 'PRIORITIZE' },
    { kw: [], label: 'DEFAULT(launch)' },
  ],
  technical: [
    { kw: ['url shortener', 'short links', 'redirect latency', 'id generation', 'redirects fast and reliable'], label: 'URL-SHORT' },
    { kw: ['article catalog', 'data model and query path', 'tables and indexes', 'publication status, publish time', 'author, publication status'], label: 'ARTICLE-CATALOG' },
    { kw: ['article metadata service', 'fetch, update, and list content', 'filters like author, status', 'contract clean and the endpoints efficient'], label: 'API-METADATA' },
    { kw: ['database schema', 'query strategy', 'publishing system', 'homepage feed', 'attach multiple tags'], label: 'DB-PUBLISH' },
    { kw: ['rate-limiting service', 'rate limiting', 'user-facing apis and internal service', 'strong consistency, latency, and ease of operation'], label: 'RATE-LIMIT' },
    { kw: ['design observability', 'observability for a backend', 'latency spikes or data goes missing', 'api layer, the database, the cache, or an async pipeline'], label: 'OBSERVABILITY' },
    { kw: ['backward-compatible v2 redesign', 'v2 redesign', 'richer filtering and sorting', 'bursty publish traffic', 'caching/async update flow'], label: 'V2-REDESIGN' },
    { kw: ['design caching', 'cache invalidation', 'staleness', 'article service', 'tag pages'], label: 'CACHE-MEDIA' },
    { kw: ['on call', 'on-call', 'incident response', 'failed article publishes', 'homepage updates'], label: 'INCIDENT' },
    { kw: ['globally distributed', 'multi-region', 'data ownership', 'failover', 'breaking-news'], label: 'GLOBAL' },
    { kw: ['rest api','public api','api design','endpoint','pagination','openapi','swagger'], label: 'API-DESIGN' },
    { kw: ['frontend','react','css','render','browser','web vitals','lcp','hydration','bundle'], label: 'FRONTEND' },
    { kw: ['test','automation','sdet','coverage','flaky','flake','e2e','integration test'], label: 'TEST' },
    { kw: ['data pipeline','ml','etl','dbt','airflow','feature store','model serving'], label: 'DATA' },
    { kw: ['design system','ux','prototype','accessibility','a11y','wcag'], label: 'DESIGN-SYS' },
    { kw: ['product','roadmap','prioritization','tech debt','velocity'], label: 'PRODUCT-TECH' },
    { kw: [], label: 'DEFAULT(kafka)' },
  ],
  'case-study': [
    { kw: ['design','ux','user research','usability','flow','interaction'], label: 'DESIGN-CASE' },
    { kw: ['pricing','monetiz','revenue','business model','plan','tier'], label: 'PRICING' },
    { kw: ['market','expansion','launch','segment','tam','geography','new product'], label: 'MARKET' },
    { kw: ['data','analysis','model','forecast','hypothesis','metric drop','funnel'], label: 'DATA-CASE' },
    { kw: [], label: 'DEFAULT(mau)' },
  ],
  'system-design': [
    { kw: ['chat','message','notification','real-time','live','presence','websocket'], label: 'CHAT' },
    { kw: ['payment','transaction','ledger','consistency','money','billing'], label: 'PAYMENT' },
    { kw: ['feed','timeline','news','social','followers'], label: 'FEED' },
    { kw: ['search','index','rank','elasticsearch','autocomplete'], label: 'SEARCH' },
    { kw: ['recommendation','ml inference','model serving','personalization'], label: 'RECS' },
    { kw: ['video','stream','live stream','vod','transcod'], label: 'VIDEO' },
    { kw: ['test framework','automated test','flaky','ci pipeline','test data','test isolation','parallel test','test runner architecture'], label: 'TEST-INFRA' },
    { kw: [], label: 'DEFAULT(webscale)' },
  ],
  coding: [
    { kw: ['tree','binary tree','bst','traversal','depth','height','ancestor'], label: 'TREE' },
    { kw: ['graph','bfs','dfs','shortest','cycle','topological','dijkstra'], label: 'GRAPH' },
    { kw: ['dp','dynamic programming','memoize','subproblem','optimal substructure'], label: 'DP' },
    { kw: ['string','substring','palindrome','anagram','subsequence'], label: 'STRING' },
    { kw: ['array','sort','two pointer','sliding window','subarray'], label: 'ARRAY' },
    { kw: ['linked list','reverse','cycle','merge'], label: 'LINKED-LIST' },
    { kw: ['stack','queue','monotonic','parenthes','bracket'], label: 'STACK' },
    { kw: ['pandas','dataframe','groupby','aggregate','event-level','event level','sql query','watch_time'], label: 'DATA-ENG' },
    { kw: ['autocomplete','debounce','react component','props','event handler','usestate','usememo','controlled input'], label: 'FRONTEND-IMPL' },
    { kw: ['lru','test runner','parameterized','test harness','implement an','implement a tiny','design a tiny','register test','cache implementation'], label: 'IMPL-DESIGN' },
    { kw: [], label: 'DEFAULT(hashmap)' },
  ],
}

function kwMatch(q, keyword) {
  const k = (keyword || '').toLowerCase().trim()
  if (!k) return false
  if (k.includes(' ')) return q.includes(k)
  if (k.length <= 4) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp('(?:^|[^a-z0-9])' + esc + '(?:[^a-z0-9]|$)').test(q)
  }
  return q.includes(k)
}

function pickStrong(question, depth) {
  const variants = STRONG_VARIANTS[depth] || STRONG_VARIANTS.behavioral
  const q = (question || '').toLowerCase()
  let bestLabel = null
  let bestLen = 0
  for (const v of variants) {
    for (const k of v.kw) {
      if (!k) continue
      if (kwMatch(q, k) && k.length > bestLen) {
        bestLen = k.length
        bestLabel = v.label
      }
    }
  }
  if (bestLabel) return bestLabel
  return variants[variants.length - 1].label
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const runs = data.runs || []

const byCell = {}
for (const r of runs) {
  if (!r.matrixKey || !r.matrixKey.endsWith('/strong')) continue
  const [domain, depth] = r.matrixKey.split('/')
  const key = `${domain}/${depth}`
  byCell[key] = byCell[key] || []
  for (const q of r.questions || []) {
    const label = pickStrong(q.question || '', depth)
    byCell[key].push({ q: (q.question || '').slice(0, 110), label })
  }
}

const cells = Object.keys(byCell).sort()
console.log(`Source: ${path.basename(jsonPath)}`)
console.log(`Strong cells found: ${cells.length} (expected 30 for a full matrix run)\n`)

let totalQ = 0
let defaultQ = 0
const cellSummary = []
for (const key of cells) {
  const entries = byCell[key]
  totalQ += entries.length
  const defaults = entries.filter((e) => e.label.startsWith('DEFAULT')).length
  defaultQ += defaults
  const labels = entries.map((e) => e.label).join(', ')
  cellSummary.push({ key, n: entries.length, defaults, labels, entries })
}

console.log('PER-CELL COVERAGE')
console.log('='.repeat(80))
for (const c of cellSummary) {
  const flag = c.defaults === c.n ? ' <-- ALL DEFAULT' : c.defaults > 0 ? ' (' + c.defaults + ' default)' : ''
  console.log(`${c.key.padEnd(30)} ${c.n}q  [${c.labels}]${flag}`)
}

console.log('\nALL-DEFAULT CELLS (red zone — variants do not fit production questions)')
console.log('='.repeat(80))
const allDefault = cellSummary.filter((c) => c.defaults === c.n)
if (!allDefault.length) {
  console.log('(none)')
} else {
  for (const c of allDefault) {
    console.log(`\n${c.key}:`)
    for (const e of c.entries) {
      console.log(`  - ${e.q}`)
    }
  }
}

console.log('\nPARTIAL-DEFAULT CELLS (yellow — some questions miss)')
console.log('='.repeat(80))
const partial = cellSummary.filter((c) => c.defaults > 0 && c.defaults < c.n)
if (!partial.length) {
  console.log('(none)')
} else {
  for (const c of partial) {
    console.log(`\n${c.key} (${c.defaults}/${c.n} default):`)
    for (const e of c.entries) {
      const tag = e.label.startsWith('DEFAULT') ? '  ⚠ ' : '  ✓ '
      console.log(`${tag}[${e.label.padEnd(15)}] ${e.q}`)
    }
  }
}

console.log('\nSUMMARY')
console.log('='.repeat(80))
console.log(`Total strong questions: ${totalQ}`)
console.log(`Matched specific variant: ${totalQ - defaultQ} (${totalQ ? Math.round((totalQ - defaultQ) / totalQ * 100) : 0}%)`)
console.log(`Fell to default: ${defaultQ} (${totalQ ? Math.round(defaultQ / totalQ * 100) : 0}%)`)
console.log(`Cells with 100% default coverage: ${allDefault.length} / ${cells.length}`)
