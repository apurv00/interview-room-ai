import { describe, it, expect } from 'vitest'
import {
  answerSuggestion,
  suggestionFamily,
  dimensionLabels,
  dimensionShortLabels,
  resolveEvalDepthSlug,
  type SuggestionInput,
} from '../answerSuggestion'

const base: SuggestionInput = { relevance: 70, structure: 70, specificity: 70, ownership: 70 }

describe('suggestionFamily', () => {
  it('maps the three special slugs, defaults everything else to behavioral', () => {
    expect(suggestionFamily('coding')).toBe('coding')
    expect(suggestionFamily('system-design')).toBe('system-design')
    expect(suggestionFamily('academics')).toBe('academics')
    expect(suggestionFamily('screening')).toBe('behavioral')
    expect(suggestionFamily(undefined)).toBe('behavioral')
    expect(suggestionFamily('SYSTEM-DESIGN')).toBe('system-design') // case-insensitive
  })
})

describe('resolveEvalDepthSlug', () => {
  it('remaps academics warm-ups (Q0/Q1) to behavioral, keeps real probes academic', () => {
    expect(resolveEvalDepthSlug('academics', 0)).toBe('behavioral')
    expect(resolveEvalDepthSlug('academics', 1)).toBe('behavioral')
    expect(resolveEvalDepthSlug('academics', 2)).toBe('academics')
    expect(resolveEvalDepthSlug('academics', 5)).toBe('academics')
  })

  it('leaves non-academics types unchanged regardless of index', () => {
    expect(resolveEvalDepthSlug('coding', 0)).toBe('coding')
    expect(resolveEvalDepthSlug('behavioral', 1)).toBe('behavioral')
    expect(resolveEvalDepthSlug('screening')).toBe('screening')
  })
})

describe('dimensionLabels', () => {
  it('labels slots per family (no more "Structure (STAR)" everywhere)', () => {
    expect(dimensionLabels(undefined).structure).toBe('Structure (STAR)')
    expect(dimensionLabels('coding').structure).toBe('Code Quality')
    expect(dimensionLabels('system-design').ownership).toBe('Trade-offs')
    expect(dimensionLabels('academics').structure).toBe('Conceptual Depth')
  })
})

describe('dimensionShortLabels', () => {
  it('gives domain-aware compact heatmap headers (no "Str" for a Code Quality column)', () => {
    expect(dimensionShortLabels(undefined).structure).toBe('Str')
    expect(dimensionShortLabels('coding').structure).toBe('Qual')
    expect(dimensionShortLabels('system-design').structure).toBe('Arch')
    expect(dimensionShortLabels('academics').ownership).toBe('Brdth')
  })
})

describe('isModelFeedback surfacing (coding/design)', () => {
  it('surfaces real feedback that opens with "Submitted" but is not a fallback template', () => {
    const s = answerSuggestion(
      { relevance: 40, structure: 40, specificity: 40, ownership: 40, answerSummary: 'Submitted solution passes the tests but is O(n^2) — use a hash map.' },
      'coding',
    )
    expect(s).toBe('Submitted solution passes the tests but is O(n^2) — use a hash map.')
  })

  it('suppresses the "Submitted <lang> solution for <title>" fallback', () => {
    const s = answerSuggestion(
      { relevance: 55, structure: 20, specificity: 55, ownership: 55, answerSummary: 'Submitted python solution for Two Sum.' },
      'coding',
    )
    expect(s?.toLowerCase()).toContain('code quality')
  })
})

describe('answerSuggestion', () => {
  it('returns null when the answer scores well enough (avg ≥ 60)', () => {
    expect(answerSuggestion(base)).toBeNull()
  })

  it('recommends STAR only when structure is actually the weakest (behavioral)', () => {
    const s = answerSuggestion({ relevance: 70, structure: 30, specificity: 65, ownership: 60 })
    expect(s).toContain('STAR')
  })

  it('does NOT recommend STAR when another dimension is weaker (the reported bug)', () => {
    // structure 50 (< the old 55 cut) but specificity 20 is the real gap.
    const s = answerSuggestion({ relevance: 70, structure: 50, specificity: 20, ownership: 70 })
    expect(s).not.toContain('STAR')
    expect(s).toContain('metrics')
  })

  it('trusts the LLM primaryGap when it names one of the four slots', () => {
    // relevance is the numeric argmin, but the model declared ownership the gap.
    const s = answerSuggestion({
      relevance: 40,
      structure: 45,
      specificity: 50,
      ownership: 55,
      primaryGap: 'ownership',
    })
    expect(s).toContain('contribution')
  })

  it('coding: surfaces the model’s own grounded feedback verbatim', () => {
    const s = answerSuggestion(
      { relevance: 40, structure: 40, specificity: 40, ownership: 40, answerSummary: 'Correct, but O(n^2) — use a hash map.' },
      'coding',
    )
    expect(s).toBe('Correct, but O(n^2) — use a hash map.')
  })

  it('coding: ignores the "Submitted …" fallback summary and gives dimension copy — never STAR', () => {
    const s = answerSuggestion(
      { relevance: 55, structure: 20, specificity: 55, ownership: 55, answerSummary: 'Submitted python solution for Two Sum.' },
      'coding',
    )
    expect(s).not.toContain('STAR')
    expect(s?.toLowerCase()).toContain('code quality')
  })

  it('system-design: surfaces model feedback when present', () => {
    const s = answerSuggestion(
      { relevance: 30, structure: 30, specificity: 30, ownership: 30, answerSummary: 'No caching layer — the read path will not scale.' },
      'system-design',
    )
    expect(s).toBe('No caching layer — the read path will not scale.')
  })

  it('academics: never recommends STAR', () => {
    const s = answerSuggestion({ relevance: 60, structure: 20, specificity: 60, ownership: 55 }, 'academics')
    expect(s).not.toContain('STAR')
    expect(s).toContain('deeper')
  })

  it('considers jdAlignment as a candidate weakest dimension when present', () => {
    // 4-dim avg = 56.5 (< 60 gate); jdAlignment 20 is the weakest overall.
    const s = answerSuggestion({ relevance: 55, structure: 58, specificity: 57, ownership: 56, jdAlignment: 20 })
    expect(s).toContain('job description')
  })
})
