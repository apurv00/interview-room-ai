import mongoose, { Schema, Document, Model } from 'mongoose'

export interface PracticeTask {
  taskId: string
  type: 'drill' | 'full_session' | 'review' | 'homework'
  title: string
  description: string
  targetCompetency: string
  difficulty: 'easy' | 'medium' | 'hard'
  estimatedMinutes: number
  completed: boolean
  completedAt?: Date
}

export interface Milestone {
  name: string
  description: string
  targetScore: number
  currentScore: number
  achieved: boolean
  achievedAt?: Date
}

export interface IPathwayPlan extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId

  // Current state assessment
  readinessLevel: 'not_ready' | 'developing' | 'approaching' | 'ready' | 'strong'
  readinessScore: number                // 0-100

  // Focus areas
  topBlockingWeaknesses: Array<{
    competency: string
    currentScore: number
    targetScore: number
    reason: string
  }>
  strengthsToPreserve: string[]

  // Next steps
  nextSessionRecommendation: {
    domain: string
    interviewType: string
    focusCompetencies: string[]
    difficulty: 'easy' | 'medium' | 'medium_high' | 'hard'
    reason: string
  }

  // Practice tasks
  practiceTasks: PracticeTask[]

  // Progression
  milestones: Milestone[]
  difficultyProgression: Array<{
    level: string
    achievedAt?: Date
    requiredScore: number
  }>

  // Session that generated this plan
  generatedFromSessionId?: mongoose.Types.ObjectId
  generatedAt: Date

  // Overall goal context
  userGoal: string
  targetRole: string
  targetTimeline?: string

  createdAt: Date
  updatedAt: Date
}

const PracticeTaskSchema = new Schema({
  taskId: { type: String, required: true },
  type: { type: String, enum: ['drill', 'full_session', 'review', 'homework'], required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  targetCompetency: { type: String, required: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  estimatedMinutes: { type: Number, default: 10 },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date },
}, { _id: false })

const MilestoneSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  targetScore: { type: Number, required: true },
  currentScore: { type: Number, default: 0 },
  achieved: { type: Boolean, default: false },
  achievedAt: { type: Date },
}, { _id: false })

const PathwayPlanSchema = new Schema<IPathwayPlan>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    readinessLevel: {
      type: String,
      enum: ['not_ready', 'developing', 'approaching', 'ready', 'strong'],
      default: 'developing',
    },
    readinessScore: { type: Number, default: 0, min: 0, max: 100 },

    topBlockingWeaknesses: [{
      competency: { type: String, required: true },
      currentScore: { type: Number, required: true },
      targetScore: { type: Number, required: true },
      reason: { type: String, default: '' },
    }],
    strengthsToPreserve: [{ type: String }],

    nextSessionRecommendation: {
      domain: { type: String, default: '' },
      interviewType: { type: String, default: '' },
      focusCompetencies: [{ type: String }],
      difficulty: { type: String, enum: ['easy', 'medium', 'medium_high', 'hard'], default: 'medium' },
      reason: { type: String, default: '' },
    },

    practiceTasks: [PracticeTaskSchema],
    milestones: [MilestoneSchema],
    difficultyProgression: [{
      level: { type: String },
      achievedAt: { type: Date },
      requiredScore: { type: Number },
    }],

    generatedFromSessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },
    generatedAt: { type: Date, default: Date.now },

    userGoal: { type: String, default: '' },
    targetRole: { type: String, default: '' },
    targetTimeline: { type: String },
  },
  { timestamps: true }
)

PathwayPlanSchema.index({ userId: 1, generatedAt: -1 })

export const PathwayPlan: Model<IPathwayPlan> =
  mongoose.models.PathwayPlan ||
  mongoose.model<IPathwayPlan>('PathwayPlan', PathwayPlanSchema)
