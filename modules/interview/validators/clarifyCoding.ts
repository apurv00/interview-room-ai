import { z } from 'zod'

/**
 * Problem context sent by the client. AI-generated problems (`ai-…` ids) do not
 * exist in the static CODING_PROBLEMS pool, so `getProblemById` can't find them
 * and the route returned "Problem not found". The client now sends the problem
 * it's displaying so the route can clarify against it. Used only as a fallback
 * when the static lookup misses; lengths are capped defensively.
 */
export const ClarifyProblemContextSchema = z.object({
  // These bounds TRUNCATE rather than reject. The client sends the problem the
  // candidate is already looking at, and AI-generated problems carry no length cap
  // — a hard `.max()` would 400 the whole clarify request on a verbose problem and
  // re-break the very thing this field fixes. (Same lesson as the resumeText
  // `.transform(slice)` guard on the generate-problem route.)
  title: z.string().transform((s) => s.slice(0, 300)),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  description: z.string().transform((s) => s.slice(0, 8000)),
  examples: z
    .array(
      z.object({
        input: z.string().transform((s) => s.slice(0, 2000)),
        output: z.string().transform((s) => s.slice(0, 2000)),
        explanation: z.string().transform((s) => s.slice(0, 2000)).optional(),
      }),
    )
    .transform((a) => a.slice(0, 12))
    .optional()
    .default([]),
  constraints: z
    .array(z.string().transform((s) => s.slice(0, 500)))
    .transform((a) => a.slice(0, 30))
    .optional()
    .default([]),
})

export const ClarifyCodingRequestSchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  problemId: z.string().min(1).max(200),
  candidateQuestion: z.string().min(1).max(2000),
  currentCode: z.string().max(50000).optional(),
  language: z.enum(['python', 'javascript', 'typescript', 'java', 'cpp']),
  problem: ClarifyProblemContextSchema.optional(),
})

export type ClarifyCodingRequest = z.infer<typeof ClarifyCodingRequestSchema>

export const AddedExampleSchema = z.object({
  input: z.string().max(2000),
  output: z.string().max(2000),
  explanation: z.string().max(2000).optional(),
})

export const ClarifyCodingResponseSchema = z.object({
  answer: z.string().min(1).max(2000),
  addedExamples: z.array(AddedExampleSchema).max(5).optional(),
  addedConstraints: z.array(z.string().max(500)).max(10).optional(),
})

export type ClarifyCodingResponse = z.infer<typeof ClarifyCodingResponseSchema>

export interface CodingClarificationRecord extends ClarifyCodingResponse {
  question: string
  problemId: string
  createdAt: string // ISO
}
