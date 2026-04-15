import { z } from 'zod'

export const InterviewConfigSchema = z.object({
  role: z.string().min(1).max(50),
  interviewType: z.string().min(1).max(50).optional().default('screening'),
  experience: z.enum(['0-2', '3-6', '7+']),
  duration: z.number().int().min(5).max(60),
  jobDescription: z.string().max(50000).optional(),
  resumeText: z.string().max(50000).optional(),
  jdFileName: z.string().max(500).optional(),
  resumeFileName: z.string().max(500).optional(),
  targetCompany: z.string().max(200).optional(),
  targetIndustry: z.string().max(200).optional(),
  privacyMode: z.boolean().optional(),
})

export const TranscriptEntrySchema = z.object({
  speaker: z.enum(['interviewer', 'candidate']),
  text: z.string().max(20000),
  timestamp: z.number(),
  questionIndex: z.number().nullish(),
})

const ProbeDecisionSchema = z.object({
  shouldProbe: z.boolean(),
  probeType: z.enum(['clarify', 'challenge', 'expand', 'quantify']).nullish(),
  probeQuestion: z.string().max(2000).nullish(),
  probingRationale: z.string().max(1000).nullish(),
})

const PushbackSchema = z.object({
  line: z.string().max(1000),
  targetDimension: z.string().max(100),
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
  needsFollowUp: z.boolean().optional(),
  followUpQuestion: z.string().max(2000).nullish(),
  flags: z.array(z.string().max(500)).max(20).optional(),
  /** G.3: integrity marker — ok | truncated | failed. See shared/types.ts. */
  status: z.enum(['ok', 'truncated', 'failed']).optional(),
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
  energy_consistency: z.number().min(0),
  composure_under_pressure: z.number().min(0),
}).passthrough()

const FeedbackDataSchema = z.object({
  overall_score: z.number().min(0).max(100),
  pass_probability: z.enum(['High', 'Medium', 'Low']),
  confidence_level: z.enum(['High', 'Medium', 'Low']),
  dimensions: z.object({
    answer_quality: z.object({
      score: z.number().min(0).max(100),
      strengths: z.array(z.string()).max(10),
      weaknesses: z.array(z.string()).max(10),
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
    requirement: z.string(),
    matched: z.boolean(),
    evidence: z.string().nullish(),
  })).optional(),
  red_flags: z.array(z.string()).max(30),
  top_3_improvements: z.array(z.string()).max(10),
  ideal_answers: z.array(z.object({
    questionIndex: z.number(),
    strongAnswer: z.string(),
    keyElements: z.array(z.string()),
  })).optional(),
  drill_recommendations: z.array(z.object({
    skillArea: z.string(),
    description: z.string(),
    practiceQuestions: z.array(z.string()),
  })).optional(),
}).passthrough()

const ThreadSummarySchema = z.object({
  topicIndex: z.number().int().min(0),
  topicQuestion: z.string().max(5000),
  summary: z.string().max(2000),
  avgScore: z.number(),
  probeCount: z.number(),
  probeTypes: z.array(z.string().max(100)).max(20),
  company: z.string().max(200).optional(),
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
  question: z.string().min(1).max(5000),
  answer: z.string().max(20000),
  questionIndex: z.number().int().min(0).max(100),
  probeDepth: z.number().int().min(0).max(20).optional(),
  sessionId: z.string().optional(),
  previousAnswerSummaries: z.array(z.object({ question: z.string(), answerSummary: z.string() })).max(10).optional(),
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
  // Retake linkage — when present, the new session is a retake of the given
  // parent session. The service resolves the root of the chain.
  parentSessionId: z.string().optional(),
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
  recordingR2Key: z.string().max(1000).optional(),
  recordingSizeBytes: z.number().int().min(0).optional(),
  screenRecordingR2Key: z.string().max(1000).optional(),
  screenRecordingSizeBytes: z.number().int().min(0).optional(),
  audioRecordingR2Key: z.string().max(1000).optional(),
  audioRecordingSizeBytes: z.number().int().min(0).optional(),
  liveTranscriptWords: z
    .array(
      z.object({
        word: z.string().max(200),
        start: z.number().min(0).max(10000),
        end: z.number().min(0).max(10000),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(50000)
    .optional(),
  codingProblemId: z.string().max(200).optional(),
  designProblemId: z.string().max(200).optional(),
  scoringDimensions: z.array(z.object({
    name: z.string(),
    label: z.string(),
    weight: z.number(),
  })).optional(),
  // G.7: session completion shape. Populated by useInterview's
  // finishInterview() when the session ends. Writing these is additive —
  // legacy clients that don't send them continue to work unchanged.
  plannedQuestionCount: z.number().int().min(0).max(100).optional(),
  answeredCount: z.number().int().min(0).max(100).optional(),
  endReason: z.enum(['normal', 'time_up', 'user_ended', 'usage_limit', 'abandoned']).optional(),
  wasTruncatedByTimer: z.array(z.boolean()).max(100).optional(),
})

// ─── LLM response schemas (Work Item G.2) ──────────────────────────────────
//
// These validate what Claude (or any routed provider) returns. They are
// deliberately PERMISSIVE: `.passthrough()` so unknown fields don't reject
// the whole payload, and dimension scores use `z.number()` only (no
// range — we don't want a slightly-out-of-range value to force the
// fallback). The goal is to catch STRUCTURAL drift (missing required
// fields, wrong JSON shape) while tolerating the benign variation Claude
// produces. If a prompt tweak legitimately adds a field, no schema
// change is needed.

/**
 * What Claude returns from `interview.evaluate-answer`. Mirrors the
 * JSON_OUTPUT_RULE block in app/api/evaluate-answer/route.ts. Dimension
 * keys are dynamic (depend on CMS rubric), so we accept any string→
 * number record and require only the four HR-screening defaults.
 */
export const EvaluateAnswerLlmSchema = z.object({
  // Core 4 dimensions (always present for HR-screening default rubric)
  relevance: z.number().optional(),
  structure: z.number().optional(),
  specificity: z.number().optional(),
  ownership: z.number().optional(),
  // Optional dimensions
  jdAlignment: z.number().optional(),
  // Metadata
  primaryGap: z.string().max(200).optional(),
  primaryStrength: z.string().max(200).optional(),
  answerSummary: z.string().max(500).optional(),
  // Probing decision
  shouldProbe: z.boolean().optional(),
  probeType: z.enum(['clarify', 'challenge', 'expand', 'quantify']).nullish(),
  probeTarget: z.string().max(500).nullish(),
  isPivot: z.boolean().optional(),
}).passthrough()

/** What Claude returns from `interview.turn-router`. */
export const TurnRouterLlmSchema = z.object({
  nextAction: z.enum(['probe', 'advance']),
  probeQuestion: z.string().max(2000).optional(),
  style: z.enum(['curious', 'probing', 'encouraging', 'neutral']).optional(),
  isNonsensical: z.boolean().optional(),
  isPivot: z.boolean().optional(),
  interruptResolution: z.enum([
    'finish_then_address',
    'abort_and_pivot',
    'acknowledge_defer',
    'absorbed',
  ]).optional(),
}).passthrough()

/**
 * What Claude returns from `interview.generate-feedback`. Looser than
 * the persistence-side `FeedbackDataSchema` above — we let `dimensions`
 * use `.passthrough()` on each sub-score so a prompt tweak that renames
 * an engagement sub-field doesn't reject the whole payload.
 */
export const FeedbackLlmSchema = z.object({
  overall_score: z.number().optional(),
  pass_probability: z.string().max(50).optional(),
  confidence_level: z.string().max(50).optional(),
  dimensions: z.object({
    answer_quality: z.object({
      score: z.number().optional(),
      strengths: z.array(z.string()).optional(),
      weaknesses: z.array(z.string()).optional(),
    }).passthrough().optional(),
    communication: z.object({
      score: z.number().optional(),
      wpm: z.number().optional(),
      filler_rate: z.number().optional(),
      pause_score: z.number().optional(),
      rambling_index: z.number().optional(),
    }).passthrough().optional(),
    engagement_signals: z.object({
      score: z.number().optional(),
      engagement_score: z.number().optional(),
      confidence_trend: z.string().max(50).optional(),
      energy_consistency: z.number().optional(),
      composure_under_pressure: z.number().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  red_flags: z.array(z.string()).optional(),
  top_3_improvements: z.array(z.string()).optional(),
  ideal_answers: z.array(z.object({
    questionIndex: z.number().optional(),
    strongAnswer: z.string().optional(),
    keyElements: z.array(z.string()).optional(),
  }).passthrough()).optional(),
  drill_recommendations: z.array(z.object({
    skillArea: z.string().optional(),
    description: z.string().optional(),
    practiceQuestions: z.array(z.string()).optional(),
  }).passthrough()).optional(),
  jd_match_score: z.number().optional(),
  jd_requirement_breakdown: z.array(z.object({
    requirement: z.string().optional(),
    matched: z.boolean().optional(),
    evidence: z.string().nullish(),
  }).passthrough()).optional(),
}).passthrough()

/**
 * What Claude returns from `interview.fusion-analysis`. Parsed in
 * modules/interview/services/analysis/fusionService.ts. `topMoments`
 * and `improvementMoments` can be either an array of indices or an
 * array of TimelineEvent objects — the caller resolves this shape in
 * `resolveEvents`. We accept both via `z.union`.
 */
const TimelineEventSchema = z.object({
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  type: z.string().max(50).optional(),
  signal: z.string().max(50).optional(),
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  severity: z.string().max(50).optional(),
  questionIndex: z.number().optional(),
}).passthrough()

export const FusionLlmSchema = z.object({
  timeline: z.array(TimelineEventSchema),
  fusionSummary: z.object({
    overallBodyLanguageScore: z.number().optional(),
    eyeContactScore: z.number().optional(),
    confidenceProgression: z.string().max(2000).optional(),
    topMoments: z.union([z.array(z.number()), z.array(TimelineEventSchema)]).optional(),
    improvementMoments: z.union([z.array(z.number()), z.array(TimelineEventSchema)]).optional(),
    coachingTips: z.array(z.string()).optional(),
  }).passthrough(),
}).passthrough()
