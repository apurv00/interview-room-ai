import { z } from 'zod'

export const InterviewConfigSchema = z.object({
  role: z.enum(['PM', 'SWE', 'Sales', 'MBA']),
  experience: z.enum(['0-2', '3-6', '7+']),
  duration: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  jobDescription: z.string().max(50000).optional(),
  resumeText: z.string().max(50000).optional(),
  jdFileName: z.string().max(500).optional(),
  resumeFileName: z.string().max(500).optional(),
})

export const TranscriptEntrySchema = z.object({
  speaker: z.enum(['interviewer', 'candidate']),
  text: z.string().max(5000),
  timestamp: z.number(),
  questionIndex: z.number().optional(),
})

export const GenerateQuestionSchema = z.object({
  config: InterviewConfigSchema,
  questionIndex: z.number().int().min(0).max(20),
  previousQA: z.array(TranscriptEntrySchema),
  templateId: z.string().optional(),
  sessionId: z.string().optional(),
})

export const EvaluateAnswerSchema = z.object({
  config: InterviewConfigSchema,
  question: z.string().min(5).max(1000),
  answer: z.string().min(1).max(5000),
  questionIndex: z.number().int().min(0).max(20),
  sessionId: z.string().optional(),
})

export const GenerateFeedbackSchema = z.object({
  config: InterviewConfigSchema,
  transcript: z.array(TranscriptEntrySchema),
  evaluations: z.array(z.any()),
  speechMetrics: z.array(z.any()),
  sessionId: z.string().optional(),
})

export const CreateSessionSchema = z.object({
  config: InterviewConfigSchema,
  templateId: z.string().optional(),
  candidateEmail: z.string().email().optional(),
  candidateName: z.string().max(200).optional(),
})

export const UpdateSessionSchema = z.object({
  status: z.enum(['created', 'in_progress', 'completed', 'abandoned']).optional(),
  transcript: z.array(TranscriptEntrySchema).optional(),
  evaluations: z.array(z.any()).optional(),
  speechMetrics: z.array(z.any()).optional(),
  feedback: z.any().optional(),
  durationActualSeconds: z.number().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})
