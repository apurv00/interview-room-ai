import { z } from 'zod'

export const ClarifyCodingRequestSchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  problemId: z.string().min(1).max(200),
  candidateQuestion: z.string().min(1).max(2000),
  currentCode: z.string().max(50000).optional(),
  language: z.enum(['python', 'javascript', 'typescript', 'java', 'cpp']),
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
