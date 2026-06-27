import { ROSTER_DOMAINS, ROSTER_DEPTHS, SMOKE_CELLS } from '../orchestrator/rosterMatrixData.mjs'
import { ROSTER_RESUMES } from '../orchestrator/rosterResumes.mjs'

const ROSTER_BLOCK_RE = /\/\/ __QA_ROSTER_START__[\s\S]*?\/\/ __QA_ROSTER_END__/

/**
 * Inline roster taxonomy into qa-matrix-runner.js (category-aware depth filtering).
 * @param {string} runnerSource
 * @returns {string}
 */
export function bakeRosterIntoRunner(runnerSource) {
  if (!ROSTER_BLOCK_RE.test(runnerSource)) {
    throw new Error('qa-matrix-runner.js missing __QA_ROSTER_START__/__QA_ROSTER_END__ markers')
  }

  const block = `// __QA_ROSTER_START__ — replaced by npm run qa:build:browser from rosterMatrixData.mjs
  const ROSTER_DOMAINS = ${JSON.stringify(ROSTER_DOMAINS)}
  const ROSTER_DEPTHS = ${JSON.stringify(ROSTER_DEPTHS)}
  const SMOKE = ${JSON.stringify(SMOKE_CELLS)}
  const ROSTER_RESUMES = ${JSON.stringify(ROSTER_RESUMES)}
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
  // __QA_ROSTER_END__`

  return runnerSource.replace(ROSTER_BLOCK_RE, block)
}
