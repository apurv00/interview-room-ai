import { z } from 'zod'
import { QuestionBank } from '@shared/db/models'

/**
 * Phase 6 — QuestionBank backfill.
 *
 * Populates the `QuestionBank` (keyed by domain × interviewType × seniorityBand)
 * with curated questions for every applicable (domain, interview-type) cell, so
 * the `question_bank_rag` retrieval path has grounding for ALL roles — not just
 * the handful seeded in seedPersonalization.ts. seniorityBand is '*' (the live
 * interview adapts difficulty by experience at runtime).
 *
 * This module is the deterministic spine — enumeration, validation, idempotent
 * upsert, and the per-cell generation prompt. The LLM generation itself runs as
 * a Workflow that feeds validated questions into `upsertCellQuestions`.
 */

// ─── Cell enumeration ────────────────────────────────────────────────────────

export interface BackfillDomain {
  slug: string
  label: string
  categorySlug?: string
  systemPromptContext?: string
}

export interface BackfillDepth {
  slug: string
  label: string
  questionStrategy?: string
  applicableDomains?: string[]
  applicableCategories?: string[]
}

export interface Cell {
  domain: string
  interviewType: string
  domainLabel: string
  depthLabel: string
  systemPromptContext: string
  questionStrategy: string
}

// The escape bucket has no curated bank of its own.
const SKIP_DOMAINS = new Set(['general'])

/**
 * A depth applies to a domain when BOTH applicability lists are empty (=all), or
 * the domain slug is whitelisted, or the domain's category is whitelisted.
 * Mirrors /api/interview-types so the backfill matrix matches what users can pick.
 */
export function depthApplies(depth: BackfillDepth, domainSlug: string, categorySlug?: string): boolean {
  const domains = depth.applicableDomains ?? []
  const cats = depth.applicableCategories ?? []
  if (domains.length === 0 && cats.length === 0) return true
  if (domains.includes(domainSlug)) return true
  return !!categorySlug && cats.includes(categorySlug)
}

/** Every (domain × applicable-type) cell that needs a question bank. */
export function enumerateCells(domains: BackfillDomain[], depths: BackfillDepth[]): Cell[] {
  const cells: Cell[] = []
  for (const d of domains) {
    if (SKIP_DOMAINS.has(d.slug)) continue
    for (const depth of depths) {
      if (!depthApplies(depth, d.slug, d.categorySlug)) continue
      cells.push({
        domain: d.slug,
        interviewType: depth.slug,
        domainLabel: d.label,
        depthLabel: depth.label,
        systemPromptContext: d.systemPromptContext ?? '',
        questionStrategy: depth.questionStrategy ?? '',
      })
    }
  }
  return cells
}

// ─── Generation output validation ────────────────────────────────────────────

export const GeneratedQuestionSchema = z.object({
  question: z.string().min(10).max(600),
  category: z.string().min(2).max(40),
  targetCompetencies: z.array(z.string().min(2)).min(1).max(5),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  idealAnswerPoints: z.array(z.string().min(3)).min(2).max(6),
  commonMistakes: z.array(z.string().min(3)).min(1).max(4),
  tags: z.array(z.string().min(2)).max(6).default([]),
})
export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>

export const CellQuestionsSchema = z.object({
  domain: z.string().min(1),
  interviewType: z.string().min(1),
  questions: z.array(GeneratedQuestionSchema).min(1),
})

/** The JSON Schema a generation agent must satisfy (for Workflow StructuredOutput). */
export const CELL_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'interviewType', 'questions'],
  properties: {
    domain: { type: 'string' },
    interviewType: { type: 'string' },
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'category', 'targetCompetencies', 'difficulty', 'idealAnswerPoints', 'commonMistakes', 'tags'],
        properties: {
          question: { type: 'string' },
          category: { type: 'string', description: 'short tag: behavioral | situational | technical | system-design | coding | case' },
          targetCompetencies: { type: 'array', items: { type: 'string' }, description: '1-3 snake_case competencies' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          idealAnswerPoints: { type: 'array', items: { type: 'string' } },
          commonMistakes: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' }, description: 'up to 4 kebab-case topic tags' },
        },
      },
    },
  },
} as const

// ─── Per-cell generation prompt ──────────────────────────────────────────────

export function buildCellPrompt(cell: Cell, count = 8): string {
  return [
    `Author ${count} distinct interview questions for a "${cell.domainLabel}" candidate in a "${cell.depthLabel}" interview.`,
    '',
    cell.systemPromptContext ? `DOMAIN CONTEXT: ${cell.systemPromptContext}` : '',
    cell.questionStrategy ? `QUESTION STRATEGY: ${cell.questionStrategy}` : '',
    '',
    `Every question must be SPECIFIC to ${cell.domainLabel} and appropriate for a ${cell.depthLabel} interview — never generic filler.`,
    'For a Core Engineering role use the real discipline (thermodynamics/CAD for mechanical, structural/geotechnical for civil, circuits/power for electrical, signals/embedded for electronics) — not software.',
    'For each question provide: question; category (behavioral|situational|technical|system-design|coding|case); targetCompetencies (1-3 snake_case); difficulty (easy|medium|hard); idealAnswerPoints (2-4); commonMistakes (1-2); tags (up to 4 kebab-case).',
    `Return { "domain": "${cell.domain}", "interviewType": "${cell.interviewType}", "questions": [...] }.`,
  ].filter(Boolean).join('\n')
}

// ─── Idempotent upsert ───────────────────────────────────────────────────────

export interface UpsertResult { domain: string; interviewType: string; inserted: number; skipped: number }

/**
 * Upsert a cell's questions, keyed by (domain, interviewType, question text) so
 * re-runs never duplicate. Existing rows are left untouched.
 */
export async function upsertCellQuestions(
  domain: string,
  interviewType: string,
  questions: GeneratedQuestion[],
): Promise<UpsertResult> {
  let inserted = 0
  let skipped = 0
  for (const q of questions) {
    const res = await QuestionBank.updateOne(
      { domain, interviewType, question: q.question },
      {
        $setOnInsert: {
          domain,
          interviewType,
          seniorityBand: '*',
          question: q.question,
          category: q.category,
          targetCompetencies: q.targetCompetencies,
          difficulty: q.difficulty,
          idealAnswerPoints: q.idealAnswerPoints,
          commonMistakes: q.commonMistakes,
          tags: q.tags ?? [],
          isActive: true,
          usageCount: 0,
        },
      },
      { upsert: true },
    )
    if (res.upsertedCount && res.upsertedCount > 0) inserted++
    else skipped++
  }
  return { domain, interviewType, inserted, skipped }
}
