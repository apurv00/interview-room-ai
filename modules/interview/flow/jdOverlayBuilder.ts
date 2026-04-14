import type { JDOverlay, JDSlotAnnotation, JDSlotInsertion, TopicSlot, ResolvedSlot } from './types'
import type { IParsedJobDescription } from '@shared/db/models/SavedJobDescription'

/**
 * Keyword-to-slot mapping for matching JD requirements to existing template slots.
 * When a JD must-have requirement contains one of these keywords, the corresponding
 * slot(s) get promoted to 'must' priority and annotated with JD context.
 */
const REQUIREMENT_TO_SLOT: Record<string, string[]> = {
  // Behavioral competencies
  'cross-functional': ['cross-team-collaboration', 'stakeholder-conflict', 'cross-functional-collaboration'],
  'collaboration': ['cross-team-collaboration', 'stakeholder-conflict', 'teamwork'],
  'leadership': ['mentorship-and-growth', 'team-building-culture', 'mentoring-junior'],
  'mentoring': ['mentorship-and-growth', 'mentoring-junior'],
  'conflict': ['conflict-resolution', 'stakeholder-conflict', 'disagreement-resolution'],
  'communication': ['communicating-findings', 'executive-communication'],
  'ambiguity': ['ambiguity-navigation', 'handling-ambiguity'],
  'prioritization': ['prioritization-tradeoffs', 'prioritization-under-pressure'],
  'data-driven': ['data-driven-decisions', 'data-driven-decision-making'],
  'influence': ['influence-without-authority', 'executive-influence'],

  // Technical competencies
  'incident': ['incident-response'],
  'production': ['incident-response', 'production-issues'],
  'system design': ['technical-decision-making', 'architecture-decisions'],
  'architecture': ['technical-decision-making', 'architecture-decisions'],
  'tech debt': ['tech-debt-prioritization'],
  'technical debt': ['tech-debt-prioritization'],
  'performance': ['performance-optimization'],
  'scalability': ['scalability-deep-dive'],
  'testing': ['testing-strategy', 'test-framework-architecture'],
  'automation': ['automation-roi-decisions', 'test-infrastructure-ownership'],
  'security': ['security-considerations'],
  'accessibility': ['accessibility-strategy', 'accessibility-implementation'],
  'ci/cd': ['cicd-testing-integration', 'cicd-quality-gates'],
  'monitoring': ['observability-monitoring'],

  // Domain-specific
  'experiment': ['experiment-design', 'ab-testing-ownership'],
  'a/b test': ['experiment-design', 'ab-testing-ownership'],
  'machine learning': ['ml-product-decisions', 'ml-algorithm-deep-dives'],
  'ml': ['ml-product-decisions', 'ml-algorithm-deep-dives'],
  'api': ['api-design', 'api-testing-depth'],
  'database': ['database-design-optimization'],
  'microservice': ['cross-service-integration'],
  'user research': ['user-advocacy', 'research-methods'],
  'design system': ['design-system-architecture', 'component-library-decisions'],
  'product sense': ['product-metrics', 'data-driven-decisions'],
  'stakeholder': ['stakeholder-conflict', 'executive-stakeholder-alignment'],
}

interface ParsedJDRequirement {
  requirement: string
  importance: 'must-have' | 'nice-to-have'
  category?: string
}

/**
 * Build a JD overlay from parsed job description requirements.
 *
 * This maps JD requirements to existing template slots:
 * - Matching slots get promoted from 'if-time' to 'must'
 * - Matching slots get annotated with JD-specific context
 * - Unmatched must-have requirements get inserted as new slots (max 2)
 *
 * The optional `warmUpSlotId` parameter targets the insertion anchor
 * for unmatched must-haves. Callers SHOULD pass the LAST warm-up
 * phase slot id from the template (a template may have multiple
 * warm-up slots; only the first becomes the resolver's warm-up
 * anchor and the rest live in the interior region preserving phase).
 * Splicing after the last warm-up slot puts JD insertions at the
 * front of the exploration-phase run so they survive must-first
 * budget fill at short durations (see resolver.ts scaling step).
 *
 * When absent, falls back to the first template slot id — correct
 * for single-warm-up templates, degraded for multi-warm-up ones. The
 * legacy middle-index rule is kept as a last-resort fallback for
 * empty inputs so the function is total.
 */
export function buildJDOverlay(
  requirements: ParsedJDRequirement[],
  existingSlotIds: string[],
  warmUpSlotId?: string,
): JDOverlay {
  const promotions: string[] = []
  const annotations: JDSlotAnnotation[] = []
  const insertions: JDSlotInsertion[] = []

  const mustHaves = requirements.filter(r => r.importance === 'must-have')

  for (const req of mustHaves) {
    const reqLower = req.requirement.toLowerCase()
    let matched = false

    // Try to match requirement to existing slots
    for (const [keyword, slotIds] of Object.entries(REQUIREMENT_TO_SLOT)) {
      if (reqLower.includes(keyword)) {
        for (const slotId of slotIds) {
          if (existingSlotIds.includes(slotId)) {
            if (!promotions.includes(slotId)) {
              promotions.push(slotId)
            }
            annotations.push({
              slotId,
              jdContext: `JD requires: "${req.requirement}". Probe this specifically.`,
            })
            matched = true
          }
        }
      }
    }

    // If no matching slot and we haven't maxed out insertions, create a new slot
    if (!matched && insertions.length < 2) {
      const slotId = `jd-req-${insertions.length + 1}`
      insertions.push({
        slot: {
          id: slotId,
          label: `JD: ${req.requirement.slice(0, 60)}`,
          competencyBucket: req.category || 'jd-requirement',
          phase: 'exploration',
          guidance: `The job description specifically requires: "${req.requirement}". Ask about the candidate's experience with this. Probe for concrete examples and measurable outcomes.`,
          probeGuidance: `Push for specifics on: ${req.requirement}. Ask for a specific project or scenario demonstrating this.`,
          maxProbes: 1,
          priority: 'must',
        },
        // Front-splice: place immediately after warm-up so the resolver's
        // must-first interior fill picks up JD insertions before template
        // must-slots located deeper in the raw order. Falls back to the
        // first template slot id (warm-up by template convention) and
        // finally to the middle-index rule for degenerate inputs.
        insertAfter:
          warmUpSlotId
          || existingSlotIds[0]
          || existingSlotIds[Math.min(Math.floor(existingSlotIds.length / 2), existingSlotIds.length - 1)],
        jdRequirement: req.requirement,
      })
    }
  }

  return { promotions, annotations, insertions }
}

/**
 * Build a JDOverlay directly from an already-parsed IParsedJobDescription
 * and the list of slot ids in the template about to be resolved.
 *
 * Pure function — no I/O. The parsed JD is expected to be fetched by the
 * caller (via getOrLoadSessionConfig.parsedJD), which means overlay building
 * happens synchronously inside the flow-resolution path with no extra Mongo
 * round trip.
 *
 * Returns null when there are no must-have requirements to process, so
 * callers can skip invoking resolveFlow with an overlay when the JD
 * contributes nothing actionable.
 */
export function buildJDOverlayFromParsedJD(
  parsed: IParsedJobDescription | null,
  existingSlotIds: string[],
  warmUpSlotId?: string,
): JDOverlay | null {
  if (!parsed || !Array.isArray(parsed.requirements) || parsed.requirements.length === 0) {
    return null
  }
  const adapted: ParsedJDRequirement[] = parsed.requirements.map(r => ({
    requirement: r.requirement,
    importance: r.importance,
    category: r.category,
  }))
  const mustHaveCount = adapted.filter(r => r.importance === 'must-have').length
  if (mustHaveCount === 0) return null
  return buildJDOverlay(adapted, existingSlotIds, warmUpSlotId)
}
