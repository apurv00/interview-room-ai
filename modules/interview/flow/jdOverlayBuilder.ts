import type { JDOverlay, JDSlotAnnotation, JDSlotInsertion, TopicSlot, ResolvedSlot } from './types'

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
 */
export function buildJDOverlay(
  requirements: ParsedJDRequirement[],
  existingSlotIds: string[],
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
        // Insert in the middle of exploration slots
        insertAfter: existingSlotIds[Math.min(Math.floor(existingSlotIds.length / 2), existingSlotIds.length - 1)] || existingSlotIds[0],
        jdRequirement: req.requirement,
      })
    }
  }

  return { promotions, annotations, insertions }
}
