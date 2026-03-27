import { z } from 'zod'

export const InterviewConfigSchema = z.object({
  role: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50).optional().default('screening'),
  experience: z.enum(['0-2', '3-6', '7+']),
  duration: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  jobDescription: z.string().max(50000).optional(),
  resumeText: z.string().max(50000).optional(),
  jdFileName: z.string().max(500).optional(),
  resumeFileName: z.string().max(500).optional(),
  targetCompany: z.string().max(200).optional(),
  targetIndustry: z.string().max(200).optional(),
})

export const TranscriptEntrySchema = z.object({
  speaker: z.enum(['interviewer', 'candidate']),
  text: z.string().max(5000),
  timestamp: z.number(),
  questionIndex: z.number().nullish(),
})

const ProbeDecisionSchema = z.object({
  shouldProbe: z.boolean(),
  probeType: z.enum(['clarify', 'challenge', 'expand', 'quantify']).nullish(),
  probeQuestion: z.string().max(500).nullish(),
  probingRationale: z.string().max(300).nullish(),
})

const PushbackSchema = z.object({
  line: z.string().max(300),
  targetDimension: z.string().max(50),
  tone: z.enum(['curious', 'probing', 'encouraging']),
})

export const AnswerEvaluationSchema = z.object({
  questionIndex: z.number().int().min(0).max(100),
  question: z.string().max(2000),
  answer: z.string().max(10000),
  relevance: z.number().min(0).max(100),
  structure: z.number().min(0).max(100),
  specificity: z.number().min(0).max(100),
  ownership: z.number().min(0).max(100),
  jdAlignment: z.number().min(0).max(100).nullish(),
  needsFollowUp: z.boolean(),
  followUpQuestion: z.string().max(500).nullish(),
  flags: z.array(z.string().max(200)).max(10),
  probeDecision: ProbeDecisionSchema.nullish(),
  pushback: PushbackSchema.nullish(),
})

export const SpeechMetricsSchema = z.object({
  wpm: z.number().min(0).max(500),
  fillerRate: z.number().min(0).max(1),
  pauseScore: z.number().min(0).max(100),
  ramblingIndex: z.number().min(0).max(1),
  totalWords: z.number().min(0),
  fillerWordCount: z.number().min(0),
  durationMinutes: z.number().min(0),
})

const EngagementSignalsSchema = z.object({
  score: z.number().min(0).max(100),
  engagement_score: z.number().min(0).max(100),
  confidence_trend: z.enum(['increasing', 'stable', 'declining']),
  energy_consistency: z.number().min(0).max(1),
  composure_under_pressure: z.number().min(0).max(100),
})

const FeedbackDataSchema = z.object({
  overall_score: z.number().min(0).max(100),
  pass_probability: z.enum(['High', 'Medium', 'Low']),
  confidence_level: z.enum(['High', 'Medium', 'Low']),
  dimensions: z.object({
    answer_quality: z.object({
      score: z.number().min(0).max(100),
      strengths: z.array(z.string().max(500)).max(10),
      weaknesses: z.array(z.string().max(500)).max(10),
    }),
    communication: z.object({
      score: z.number().min(0).max(100),
      wpm: z.number(),
      filler_rate: z.number(),
      pause_score: z.number(),
      rambling_index: z.number(),
    }),
    engagement_signals: EngagementSignalsSchema,
  }).passthrough(), // allow legacy delivery_signals
  jd_match_score: z.number().min(0).max(100).optional(),
  jd_requirement_breakdown: z.array(z.object({
    requirement: z.string().max(500),
    matched: z.boolean(),
    evidence: z.string().max(500).optional(),
  })).optional(),
  red_flags: z.array(z.string().max(500)).max(20),
  top_3_improvements: z.array(z.string().max(500)).max(5),
})

const ThreadSummarySchema = z.object({
  topicIndex: z.number().int().min(0),
  topicQuestion: z.string().max(1000),
  summary: z.string().max(500),
  avgScore: z.number(),
  probeCount: z.number(),
  probeTypes: z.array(z.string().max(50)).max(10),
})

export const GenerateQuestionSchema = z.object({
  config: InterviewConfigSchema,
  questionIndex: z.number().int().min(0).max(100),
  previousQA: z.array(TranscriptEntrySchema),
  performanceSignal: z.enum(['calibrating', 'struggling', 'on_track', 'strong']).optional(),
  lastThreadSummary: ThreadSummarySchema.optional(),
  completedThreads: z.array(ThreadSummarySchema).max(20).optional(),
  templateId: z.string().optional(),
  sessionId: z.string().optional(),
})

export const EvaluateAnswerSchema = z.object({
  config: InterviewConfigSchema,
  question: z.string().min(5).max(2000),
  answer: z.string().min(1).max(10000),
  questionIndex: z.number().int().min(0).max(100),
  probeDepth: z.number().int().min(0).max(10).optional(),
  sessionId: z.string().optional(),
})

export const GenerateFeedbackSchema = z.object({
  config: InterviewConfigSchema,
  transcript: z.array(TranscriptEntrySchema),
  evaluations: z.array(AnswerEvaluationSchema),
  speechMetrics: z.array(SpeechMetricsSchema),
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
  evaluations: z.array(AnswerEvaluationSchema).optional(),
  speechMetrics: z.array(SpeechMetricsSchema).optional(),
  feedback: FeedbackDataSchema.optional(),
  durationActualSeconds: z.number().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})
