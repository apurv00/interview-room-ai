/**
 * Semantic near-duplicate detection for generated problems.
 *
 * The avoid-list in the generation prompt is advisory — the LLM can still
 * produce "URL Shortener" under a new name. This is the post-parse guard:
 * token-Jaccard between the candidate problem's title∪tags and each served
 * problem's title. Ledger rows persist titles only, so the comparison is
 * candidate(title+tags) vs served(title) — asymmetric but effective, since a
 * renamed variant almost always keeps the load-bearing nouns.
 */

/** Words that carry no scenario identity — dropped before comparison. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'with', 'and', 'or', 'to', 'at',
  'design', 'implement', 'build', 'create', 'write', 'system', 'problem',
  'service', 'basic', 'simple', 'ai', 'generated',
])

/** Lowercased, punctuation-stripped, stopword-filtered token set. */
export function fingerprintTokens(title: string, tags: string[] = []): Set<string> {
  const raw = [title, ...tags].join(' ').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
  const tokens = raw.split(/[\s-]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  return new Set(tokens)
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  a.forEach((t) => { if (b.has(t)) intersection++ })
  return intersection / (a.size + b.size - intersection)
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6

/**
 * Returns the first served title the candidate is a near-duplicate of, or null.
 * `served` should be most-recent-first so the reported collision is the one
 * the user saw most recently.
 *
 * Scores MAX(title-only, title∪tags) against each served title: tags are an
 * extra signal for title-evasive renames, but they must never DILUTE a plain
 * title match — a regenerated "Two Sum" with tags [arrays, hash-map] would
 * otherwise score 0.4 on the merged set and slip past the 0.6 threshold
 * (Codex P2 on #486).
 */
export function findNearDuplicate(
  candidate: { title: string; tags?: string[] },
  served: Array<{ title?: string }>,
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
): { title: string } | null {
  const titleTokens = fingerprintTokens(candidate.title)
  const mergedTokens = fingerprintTokens(candidate.title, candidate.tags ?? [])
  if (titleTokens.size === 0 && mergedTokens.size === 0) return null
  for (const s of served) {
    if (!s.title) continue
    const servedTokens = fingerprintTokens(s.title)
    const score = Math.max(
      jaccard(titleTokens, servedTokens),
      jaccard(mergedTokens, servedTokens),
    )
    if (score >= threshold) {
      return { title: s.title }
    }
  }
  return null
}
