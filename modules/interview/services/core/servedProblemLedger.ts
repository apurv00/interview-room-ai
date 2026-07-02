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

/**
 * Most-recently-served-first problem ids for a user+kind.
 * Returns [] on any failure — exclusion must never block problem delivery;
 * callers union this with the client-sent list, so a miss only degrades
 * exclusion back to the client's view, never below it.
 */
export async function getServedProblemIds(
  userId: string,
  kind: ServedProblemKind,
): Promise<string[]> {
  try {
    await connectDB()
    const rows = await ServedProblem.find({ userId, kind })
      .sort({ servedAt: -1 })
      .limit(LEDGER_READ_LIMIT)
      .select('problemId')
      .lean()
    return rows.map((r) => r.problemId).filter(Boolean)
  } catch (err) {
    aiLogger.warn({ err, kind }, 'servedProblemLedger: read failed — degrading to client exclusion list')
    return []
  }
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
