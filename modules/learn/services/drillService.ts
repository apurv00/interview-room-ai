import { createHash } from 'crypto'
import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { DrillAttempt } from '@shared/db/models/DrillAttempt'
import { aiLogger as logger } from '@shared/logger'
import { redis } from '@shared/redis'
import type { AnswerEvaluation } from '@shared/types'
import { generateEmbedding } from '@interview/services/core/embeddingService'

export interface WeakQuestion {
  sessionId: string
  questionIndex: number
  question: string
  answer: string
  avgScore: number
  relevance: number
  structure: number
  specificity: number
  ownership: number
  competency: string
  sessionDate: string
  /**
   * Number of past attempts on the same (normalized) question across
   * the user's interview history. Always >= 1. The cluster surfaced
   * here is the WORST-scoring attempt (lowest avg). Used by the
   * drill-list UI to show a "N attempts" chip when > 1 so users
   * know the question was clubbed. E1 on the drill-mode improvements.
   */
  attemptCount: number
}

/**
 * Aggressive normalization for cluster-key matching:
 *   1. Lowercase
 *   2. Drop apostrophes entirely so contractions collapse with their
 *      stripped form ("what's" matches "whats")
 *   3. Replace anything that isn't a Unicode letter, number, or
 *      whitespace with a space — so trailing punctuation and
 *      surrounding quotes don't split clusters ("...led a team." vs
 *      "...led a team"). Uses `\p{L}\p{N}` with the `u` flag so
 *      accented Latin ("São Paulo", "naïve") and non-Latin scripts
 *      (CJK, Cyrillic, Arabic, Devanagari) survive — the prior
 *      `\w` was ASCII-only and would collapse every non-Latin
 *      question to the empty string, dedup'ing all of them into a
 *      single survivor (Codex P1 on PR #394).
 *   4. Collapse whitespace runs + trim
 *
 * Implementation note: built via `new RegExp(...)` instead of a
 * literal so the `u`-flag check (TS1501 — only available at es6+)
 * isn't triggered by the parser. The tsconfig doesn't set a `target`,
 * which defaults to ES3 for the literal check. Bumping `target` for
 * the whole project is a much bigger surface than this one regex
 * needs.
 */
const NON_LETTER_NUMBER_OR_SPACE_RE = new RegExp('[^\\p{L}\\p{N}\\s]', 'gu')

function normalizeQuestionForDedup(q: string): string {
  return q
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(NON_LETTER_NUMBER_OR_SPACE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Detects the AI interviewer's opening greeting. Templates live at
 * `modules/interview/config/interviewConfig.ts` (PM/SWE/Sales/MBA
 * role-specific + the generic fallback) and `useInterview.ts`
 * (coding/design). Codex P2 (round 2) on PR #397: the prior
 * `^Hi[!,]…` matcher missed SWE ("Hey, welcome! I'm Alex…"), Sales
 * ("Great to meet you! I'm Alex…") and MBA ("Hello! I'm Alex…")
 * openers — those role flows still leaked AI greetings into the
 * drill list.
 *
 * Common anchor across every known variant: the string `I'm Alex`
 * appears within the first ~40 characters. We use a length-bounded
 * prefix match so a candidate question that happens to mention
 * "Alex" later on doesn't accidentally trip the filter.
 *
 * Apostrophe character class accepts ASCII `'`, typographic right-
 * single-quotation-mark (`U+2019`), and left (`U+2018`) — LLMs
 * sometimes substitute smart quotes when echoing the question text.
 */
// Explicit \uXXXX escapes for the apostrophe character class so the
// smart quotes survive any tool/editor pass that might silently
// normalize them to ASCII (Codex P2 round 3 on PR #397 — the literal
// smart-quote chars in the prior commit got flattened to ASCII `'`
// during a tool write, breaking the smart-quote claim in the JSDoc).
//   ' = ASCII apostrophe '
//   ‘ = LEFT  SINGLE QUOTATION MARK
//   ’ = RIGHT SINGLE QUOTATION MARK (typographic; common in
//            LLM-echoed question text)
const AI_INTRO_GREETING_RE = /^.{0,40}I[\u0027\u2018\u2019]?m\s+Alex\b/i

function isAIIntroGreeting(question: string | undefined | null): boolean {
  if (!question) return false
  return AI_INTRO_GREETING_RE.test(question.trim())
}

// ─── Semantic clustering (embeddings) ────────────────────────────────────────
//
// E1 follow-up (2026-05-19): user reported the drill list still showed
// duplicates after the text-normalizer clustering shipped in PR #394.
// Inspection of their actual data confirmed:
//   1. The normalizer DID work for exact-match duplicates (chips showed
//      "2 attempts" on those).
//   2. The visible duplicates were SEMANTIC — same intent, different
//      LLM wording:
//        - "Tell me about a time you owned a product launch end to end…"
//          vs "Can you walk me through a real product launch you owned?"
//        - Intro greeting templates with the domain swapped in the
//          middle (`Pm behavioral` vs `Pm technical deep-dive`)
//
// Embeddings catch both because they compare meaning, not surface text.
// We reuse the existing `generateEmbedding` helper (OpenAI
// text-embedding-3-small, 1536 dims).

/** Threshold above which two questions are treated as the same cluster.
 *  0.85 is a conservative semantic-similarity bar for sentence embeddings —
 *  catches paraphrases without over-clustering genuinely different
 *  questions on related topics. Tunable based on production feedback. */
const SEMANTIC_CLUSTER_THRESHOLD = 0.85

/** Redis cache TTL for question embeddings — 30 days. Embeddings are
 *  deterministic for a given (model, text) so the only reason to expire
 *  is to recover RAM if the question text is never queried again. */
const EMBEDDING_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60

function embeddingCacheKey(text: string): string {
  return `qemb:v1:${createHash('sha1').update(text).digest('hex')}`
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Hard cap on the number of unique question texts we'll embed in one
 *  drill-list request. Beyond this we fall back to text-clustering for
 *  the whole batch (Codex P2 on PR #397: heavy users with many weak
 *  questions across 20 sessions could otherwise trigger 100+ parallel
 *  OpenAI calls per drill-list load — added latency + cost + tail-error
 *  amplification). 50 is comfortably above any realistic drill-list
 *  size for normal users; if a user exceeds it, their list reverts to
 *  the PR #394 text-cluster behaviour (still useful, just less
 *  aggressive). */
const MAX_EMBEDDING_FANOUT = 50

/** Threshold for "the embedding service is unhealthy, bail to text
 *  fallback rather than serve degraded semantic clustering". Triggered
 *  when more than half of fresh fetches fail. */
const EMBEDDING_FAILURE_BAIL_RATIO = 0.5

/**
 * Fetch embeddings for a list of question texts, deduplicating
 * identical texts and using Redis as a cross-request cache. Returns
 * a Map keyed by the original text, or `null` when the caller should
 * fall back to text-based clustering entirely (over the fan-out cap,
 * or majority of fresh fetches failed).
 *
 * Partial failures (a few embedding calls reject) do NOT bail — the
 * cluster function treats missing entries as their own clusters, so
 * the user still gets a usable list with fewer semantic matches.
 *
 * Cost shape: first call for a fresh question text = one OpenAI
 * embedding API call (~$0.00002 per question for text-embedding-3-
 * small). Subsequent calls hit the Redis cache. Across users the
 * cache is shared by exact text match, so popular questions
 * ("Tell me about yourself") only pay the embedding cost once.
 */
async function getEmbeddingsForTexts(
  texts: string[],
): Promise<Map<string, number[]> | null> {
  const uniqueTexts = Array.from(new Set(texts))
  const result = new Map<string, number[]>()
  if (uniqueTexts.length === 0) return result

  // Fan-out cap (Codex P2): bail to text-clustering rather than fire
  // an unbounded number of parallel embedding requests.
  if (uniqueTexts.length > MAX_EMBEDDING_FANOUT) {
    logger.info(
      { uniqueTextCount: uniqueTexts.length, cap: MAX_EMBEDDING_FANOUT },
      'drillService: weak-question count exceeds embedding fan-out cap; falling back to text-clustering',
    )
    return null
  }

  // Phase 1: try Redis batch read for everything we know about.
  const keys = uniqueTexts.map(embeddingCacheKey)
  let cachedRaw: Array<string | null> = []
  try {
    cachedRaw = await redis.mget(...keys)
  } catch (err) {
    logger.warn({ err }, 'drillService: redis embedding cache mget failed; proceeding without cache')
    cachedRaw = new Array(uniqueTexts.length).fill(null)
  }

  const toFetch: string[] = []
  for (let i = 0; i < uniqueTexts.length; i++) {
    const raw = cachedRaw[i]
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as number[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          result.set(uniqueTexts[i], parsed)
          continue
        }
      } catch {
        // Bad cache entry — fall through to refetch.
      }
    }
    toFetch.push(uniqueTexts[i])
  }

  if (toFetch.length === 0) return result

  // Phase 2: parallel-fetch the cache misses via allSettled — Codex P2:
  // Promise.all would reject the whole batch on a single transient
  // failure, dropping semantic clustering for everyone. allSettled
  // lets the partial-success path through; clusterByEmbedding treats
  // missing entries as their own clusters so the list still works.
  const settled = await Promise.allSettled(
    toFetch.map((text) => generateEmbedding(text).then((emb) => [text, emb] as const)),
  )
  let failures = 0
  const fetched: Array<readonly [string, number[]]> = []
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      fetched.push(r.value)
      result.set(r.value[0], r.value[1])
    } else {
      failures++
    }
  }

  // If the majority of the OVERALL workload (cache hits + fresh
  // fetches) failed, the embedding service is unhealthy — bail to
  // text-clustering rather than serve a list where most items don't
  // cluster with anything. Codex P2 round 3 on PR #397: prior
  // denominator was `toFetch.length`, which made a single failed
  // cache miss with mostly-cached siblings trip the bail (e.g. 49
  // cache hits + 1 fresh fail → 1 > 0.5 = true → drop semantic
  // clustering despite 98% of data being available). Using
  // `uniqueTexts.length` ties the threshold to the request size,
  // not just the fresh-fetch slice.
  if (failures > uniqueTexts.length * EMBEDDING_FAILURE_BAIL_RATIO) {
    logger.warn(
      { failures, attempted: toFetch.length, total: uniqueTexts.length },
      'drillService: majority of embedding fetches failed; falling back to text-clustering',
    )
    return null
  }

  // Fire-and-forget cache write — failure to cache doesn't break the
  // current request, just means we'll regenerate next time.
  void (async () => {
    try {
      const pipeline = fetched.map(([text, emb]) =>
        redis.setex(embeddingCacheKey(text), EMBEDDING_CACHE_TTL_SECONDS, JSON.stringify(emb)),
      )
      await Promise.allSettled(pipeline)
    } catch (err) {
      logger.warn({ err }, 'drillService: redis embedding cache write failed')
    }
  })()

  return result
}

/**
 * Cluster weak questions by semantic similarity using embeddings.
 * Returns the deduplicated list with `attemptCount` stamped onto each
 * survivor (the lowest-scoring member of the cluster, preserving the
 * "drill where I'm weakest" mental model).
 *
 * Greedy union-find: walk weak questions in score-ascending order; for
 * each, compute cosine similarity against existing cluster
 * representatives and merge into the first one above the threshold.
 * O(N²) in the number of weak questions — fine for the practical
 * limit (≤MAX_EMBEDDING_FANOUT).
 *
 * Partial-failure handling (Codex P2 round 2 on PR #397): when an
 * embedding call failed for a specific text but the batch as a whole
 * survived, that text has no entry in `embeddings`. Those items fall
 * back to text-key clustering (same key as `clusterByText`) so two
 * identical-text questions whose embeddings both failed STILL collapse
 * to one card with `attemptCount: 2` — not two separate cards. Mixed
 * pairs (one embedded, one not) can't be compared, so they stay
 * separate (worst case: a tiny over-count of cards under partial
 * outage, but never an under-count of `attemptCount`).
 */
function clusterByEmbedding(
  weak: WeakQuestion[],
  embeddings: Map<string, number[]>,
): WeakQuestion[] {
  type Cluster = {
    rep: WeakQuestion
    count: number
    /** Empty when this cluster is text-keyed (embedding fetch failed). */
    embedding: number[]
    /** Set when this cluster is text-keyed; matched by exact equality. */
    textKey?: string
  }
  const clusters: Cluster[] = []

  for (const q of weak.sort((a, b) => a.avgScore - b.avgScore)) {
    const emb = embeddings.get(q.question)
    let matched: Cluster | null = null

    if (emb) {
      // Embedded: cosine against other embedded clusters.
      for (const c of clusters) {
        if (c.embedding.length === 0) continue
        if (cosineSimilarity(emb, c.embedding) >= SEMANTIC_CLUSTER_THRESHOLD) {
          matched = c
          break
        }
      }
    } else {
      // Not embedded: exact text-key match against other text-keyed
      // clusters. Preserves the PR #394 behaviour for the unembedded
      // subset under partial outages.
      const textKey = normalizeQuestionForDedup(q.question)
      for (const c of clusters) {
        if (c.textKey !== undefined && c.textKey === textKey) {
          matched = c
          break
        }
      }
    }

    if (matched) {
      matched.count += 1
      // Keep the existing rep (already lowest-scoring since we sort asc).
    } else if (emb) {
      clusters.push({ rep: q, count: 1, embedding: emb })
    } else {
      clusters.push({
        rep: q,
        count: 1,
        embedding: [],
        textKey: normalizeQuestionForDedup(q.question),
      })
    }
  }

  return clusters.map((c) => ({ ...c.rep, attemptCount: c.count }))
}

/**
 * Fallback text-based clustering — same logic as the pre-embedding
 * implementation. Used when the embedding API or Redis is down so the
 * drill list still works (just with fewer semantic matches).
 */
function clusterByText(weak: WeakQuestion[]): WeakQuestion[] {
  const counts = new Map<string, number>()
  for (const q of weak) {
    counts.set(normalizeQuestionForDedup(q.question), (counts.get(normalizeQuestionForDedup(q.question)) ?? 0) + 1)
  }

  const seen = new Set<string>()
  const deduped: WeakQuestion[] = []
  for (const q of weak.sort((a, b) => a.avgScore - b.avgScore)) {
    const key = normalizeQuestionForDedup(q.question)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ ...q, attemptCount: counts.get(key) ?? 1 })
  }
  return deduped
}

export interface DrillResult {
  questionIndex: number
  question: string
  originalScore: number
  newScore: number
  delta: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
}

export interface DrillHistoryEntry {
  id: string
  question: string
  originalScore: number
  newScore: number
  delta: number
  competency: string
  createdAt: string
  /**
   * Pathway P2 Wave 5 — per-dimension breakdown, present only on rows
   * persisted after the schema upgrade. Old rows fall back to avg
   * delta (`delta` field) in downstream UI.
   */
  breakdown?: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
}

/**
 * Get questions where user scored poorly (avg < 60).
 */
export async function getWeakQuestions(
  userId: string,
  limit = 10,
  competency?: string,
): Promise<WeakQuestion[]> {
  try {
    await connectDB()

    const sessions = await InterviewSession.find({
      userId: new mongoose.Types.ObjectId(userId),
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('evaluations createdAt config')
      .lean()

    const weak: WeakQuestion[] = []

    for (const session of sessions) {
      const evals = (session.evaluations || []) as AnswerEvaluation[]
      for (const ev of evals) {
        // Skip evals where the LLM couldn't actually score the answer.
        // Default fallback values (0/0/0/0) would pass the avg < 60
        // check below and pollute the drill list with non-drillable
        // entries.
        if ((ev as { status?: string }).status === 'failed') continue

        // Skip the AI's opening greeting ("Hi, I'm Alex…") — it isn't
        // a drillable question, it's the interviewer's intro. Codex
        // P2 on PR #397: the prior all-zero-scores filter would
        // ALSO hide a candidate's legitimately blank/off-topic answer
        // (which is precisely what drill mode should surface), so
        // targeting the question text is the correct signal.
        if (isAIIntroGreeting(ev.question)) continue

        const avg = Math.round(
          (ev.relevance + ev.structure + ev.specificity + ev.ownership) / 4
        )
        if (avg >= 60) continue

        // Determine weakest competency
        const scores = {
          relevance: ev.relevance,
          structure: ev.structure,
          specificity: ev.specificity,
          ownership: ev.ownership,
        }
        const weakestDim = Object.entries(scores)
          .sort((a, b) => a[1] - b[1])[0][0]

        if (competency && weakestDim !== competency) continue

        weak.push({
          sessionId: session._id.toString(),
          questionIndex: ev.questionIndex,
          question: ev.question,
          answer: ev.answer,
          avgScore: avg,
          relevance: ev.relevance,
          structure: ev.structure,
          specificity: ev.specificity,
          ownership: ev.ownership,
          competency: weakestDim,
          sessionDate: session.createdAt.toISOString(),
          // Filled in by the cluster pass below.
          attemptCount: 1,
        })
      }
    }

    // Two-tier cluster: try embeddings (catches semantic duplicates
    // like main-question + follow-up probe + intro greetings with
    // domain swapped), fall back to text-based clustering (the
    // pre-embedding behaviour from PR #394) when the embedding API
    // is unavailable or Redis is degraded.
    //
    // Both paths produce the same shape: deduplicated WeakQuestion[]
    // with `attemptCount` stamped on the survivor (the lowest-scoring
    // attempt of each cluster). The survivor selection logic is
    // identical — only the cluster-key derivation differs.
    let deduped: WeakQuestion[]
    const embeddings = await getEmbeddingsForTexts(weak.map((q) => q.question))
    if (embeddings) {
      deduped = clusterByEmbedding(weak, embeddings)
    } else {
      // Embedding API failed; fall back so the drill list still works.
      deduped = clusterByText(weak)
    }

    return deduped.slice(0, limit)
  } catch (err) {
    logger.error({ err }, 'Failed to get weak questions')
    return []
  }
}

/**
 * Save a drill attempt result.
 *
 * Wave 5 — `breakdown` is now persisted (previously only `delta`
 * survived; per-dim scores were thrown away after the avg rolled up
 * into `newScore`). Field is optional so callers that haven't been
 * updated yet still work, but the evaluate route DOES pass it.
 */
export async function saveDrillAttempt(
  userId: string,
  data: {
    sessionId: string
    questionIndex: number
    question: string
    originalAnswer: string
    originalScore: number
    newAnswer: string
    newScore: number
    competency: string
    breakdown?: {
      relevance: number
      structure: number
      specificity: number
      ownership: number
    }
  },
): Promise<DrillResult> {
  await connectDB()

  const delta = data.newScore - data.originalScore

  await DrillAttempt.create({
    userId: new mongoose.Types.ObjectId(userId),
    sessionId: new mongoose.Types.ObjectId(data.sessionId),
    questionIndex: data.questionIndex,
    question: data.question,
    originalAnswer: data.originalAnswer,
    originalScore: data.originalScore,
    newAnswer: data.newAnswer,
    newScore: data.newScore,
    delta,
    competency: data.competency,
    ...(data.breakdown && { breakdown: data.breakdown }),
  })

  return {
    questionIndex: data.questionIndex,
    question: data.question,
    originalScore: data.originalScore,
    newScore: data.newScore,
    delta,
    breakdown: data.breakdown ?? {
      relevance: 0,
      structure: 0,
      specificity: 0,
      ownership: 0,
    },
  }
}

/**
 * Get recent drill attempts for a user.
 *
 * Wave 5 — optional `competency` filter so callers can ask "show me
 * just the relevance drills" without pulling everything and filtering
 * client-side. The new `/api/learn/drill/history` route uses this for
 * `DeltaContextNote`'s "average delta on relevance" trend, and the
 * filter happens in Mongo so the limit applies to the post-filter
 * count (otherwise the limit was being spent on irrelevant rows).
 */
export async function getDrillHistory(
  userId: string,
  limit = 20,
  competency?: string,
): Promise<DrillHistoryEntry[]> {
  try {
    await connectDB()

    const filter: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(userId),
    }
    if (competency) filter.competency = competency

    const attempts = await DrillAttempt.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()

    return attempts.map(a => ({
      id: a._id.toString(),
      question: a.question,
      originalScore: a.originalScore,
      newScore: a.newScore,
      delta: a.delta,
      competency: a.competency,
      createdAt: a.createdAt.toISOString(),
      // Wave 5 — backwards-compat: old rows lack `breakdown`; pass
      // through `undefined` so UI consumers know to fall back to
      // avg-only trend rather than rendering a zero row.
      ...(a.breakdown && { breakdown: a.breakdown }),
    }))
  } catch (err) {
    logger.error({ err }, 'Failed to get drill history')
    return []
  }
}
