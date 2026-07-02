import { connectDB } from '@shared/db/connection'
import { ServedProblem } from '@shared/db/models/ServedProblem'
import { aiLogger } from '@shared/logger'

export type ServedProblemKind = 'coding' | 'system-design'

export interface ServedProblemEntry {
  userId: string
  kind: ServedProblemKind
  problemId: string
  title?: string
  domain?: string
  difficulty?: 'easy' | 'medium' | 'hard'
  source: 'static' | 'ai'
  /** Full problem JSON — persist for AI problems so they can be rebuilt/deduped */
  problemBody?: unknown
}

/** How many ledger rows exclusion reads consider (most recent first). */
const LEDGER_READ_LIMIT = 300

export interface ServedProblemSummary {
  problemId: string
  title?: string
}

/**
 * Most-recently-served-first {problemId, title} rows for a user+kind.
 * Returns [] on any failure — exclusion must never block problem delivery;
 * callers union this with the client-sent list, so a miss only degrades
 * exclusion back to the client's view, never below it.
 */
export async function getServedProblemSummaries(
  userId: string,
  kind: ServedProblemKind,
): Promise<ServedProblemSummary[]> {
  try {
    await connectDB()
    const rows = await ServedProblem.find({ userId, kind })
      .sort({ servedAt: -1 })
      .limit(LEDGER_READ_LIMIT)
      .select('problemId title')
      .lean()
    return rows
      .filter((r) => r.problemId)
      .map((r) => ({ problemId: r.problemId, title: r.title || undefined }))
  } catch (err) {
    aiLogger.warn({ err, kind }, 'servedProblemLedger: read failed — degrading to client exclusion list')
    return []
  }
}

/** Most-recently-served-first problem ids for a user+kind ([] on failure). */
export async function getServedProblemIds(
  userId: string,
  kind: ServedProblemKind,
): Promise<string[]> {
  return (await getServedProblemSummaries(userId, kind)).map((s) => s.problemId)
}

/**
 * How many problems this user has been served in a domain — drives the
 * progressive-difficulty nudge in the generation prompts. 0 on failure.
 */
export async function countServedProblems(
  userId: string,
  kind: ServedProblemKind,
  domain: string,
): Promise<number> {
  try {
    await connectDB()
    return await ServedProblem.countDocuments({ userId, kind, domain })
  } catch (err) {
    aiLogger.warn({ err, kind, domain }, 'servedProblemLedger: count failed')
    return 0
  }
}

/**
 * Union ledger summaries (titled, most-recent-first, authoritative) with
 * client-sent bare ids into avoid-list entries. Ledger entries first so
 * downstream prompt caps keep the freshest — and titled — exclusions.
 */
export function unionAvoidEntries(
  ledger: ServedProblemSummary[],
  clientIds: string[],
): Array<{ id: string; title?: string }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; title?: string }> = []
  for (const l of ledger) {
    if (!l.problemId || seen.has(l.problemId)) continue
    seen.add(l.problemId)
    out.push({ id: l.problemId, title: l.title })
  }
  for (const id of clientIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id })
  }
  return out
}

/**
 * Record a served problem. Idempotent: upsert against the unique
 * {userId, kind, problemId} index — immutable fields first-write-win
 * ($setOnInsert), so concurrent tabs and redundant client+server records
 * collapse to one row. `servedAt` is $set on EVERY record: when the pool is
 * exhausted and selectLeastRecentlyServed repeats a problem, the repeat must
 * bump its recency so successive exhausted rounds rotate through the pool
 * instead of replaying the same "oldest" problem (Codex P2 on PR #485).
 * Swallows errors — recording must never block or fail problem delivery.
 */
export async function recordServedProblem(entry: ServedProblemEntry): Promise<void> {
  try {
    await connectDB()
    await ServedProblem.updateOne(
      { userId: entry.userId, kind: entry.kind, problemId: entry.problemId },
      {
        $set: { servedAt: new Date() },
        $setOnInsert: {
          title: (entry.title ?? '').slice(0, 200),
          domain: entry.domain,
          difficulty: entry.difficulty,
          source: entry.source,
          problemBody: entry.problemBody,
        },
      },
      { upsert: true },
    )
  } catch (err) {
    aiLogger.warn({ err, kind: entry.kind, problemId: entry.problemId }, 'servedProblemLedger: record failed')
  }
}

/**
 * Union two most-recent-first id lists, preserving order and de-duplicating.
 * Primary (the server ledger) wins ordering; secondary ids (client-sent /
 * legacy InterviewSession-derived) append after, so downstream prompt caps
 * (`slice(0, N)`) keep the freshest exclusions.
 */
export function unionMostRecentFirst(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...primary, ...secondary]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
