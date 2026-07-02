import { TEMPLATE_REGISTRY } from './templates'
import { makeTemplateKey } from './types'
import type { ExperienceLevel } from '@shared/types'

/**
 * Follow-up calibration for the coding / system-design artifact evaluators.
 *
 * The scripted coding/SD rounds never run the flow engine, so the authored
 * templates' per-band probeGuidance and neverAsk guardrails were dead content
 * on this path. This helper renders them into a compact block the
 * evaluate-code / evaluate-design prompts splice in, so the grounded
 * follow-up the LLM writes is pitched at the candidate's experience band
 * (e.g. entry bands never get the CAP-theorem trade-off their templates
 * explicitly forbid). Pure and synchronous; returns '' whenever inputs are
 * missing or no template matches — calibration must never block evaluation.
 */

const MAX_PROBE_LINES = 4
const MAX_LINE_LEN = 220

export function buildFollowUpCalibration(
  domain: string | undefined,
  depth: 'coding' | 'system-design',
  experience: string | undefined,
): string {
  if (!domain || !experience) return ''

  const template =
    TEMPLATE_REGISTRY.get(makeTemplateKey(domain, depth, experience as ExperienceLevel)) ??
    TEMPLATE_REGISTRY.get(makeTemplateKey('general', depth, experience as ExperienceLevel))
  if (!template) return ''

  // Exploration/deep-dive slots carry the expert probing angles; warm-up and
  // closing guidance is surface-level by design.
  const probeLines = template.slots
    .filter((s) => (s.phase === 'exploration' || s.phase === 'deep-dive') && s.probeGuidance)
    .slice(0, MAX_PROBE_LINES)
    .map((s) => `- ${s.probeGuidance.slice(0, MAX_LINE_LEN)}`)

  const neverAsk = template.neverAsk.length
    ? `\nNever ask about (wrong register for this seniority): ${template.neverAsk.slice(0, 5).join('; ')}.`
    : ''

  if (probeLines.length === 0 && !neverAsk) return ''

  // Plain text, NOT XML-wrapped: the eval prompts carry DATA_BOUNDARY_RULE,
  // which declares XML-tagged content reference-data-only and its embedded
  // directives void — wrapping these (trusted, statically-authored) guardrails
  // in tags would instruct the model to ignore them (Codex P2 on #487). This
  // block belongs in the SYSTEM prompt, not the user message.
  return `
FOLLOW-UP CALIBRATION (trusted interviewer guidance for the grounded follow-up):
Probing angles appropriate for a ${experience}-years ${domain} candidate in this round:
${probeLines.join('\n')}${neverAsk}
`
}
