import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IWeaknessCluster extends Document {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  weaknessName: string                    // e.g. "generic_under_pressure", "missing_metrics"
  description: string                      // human-readable description
  severity: 'critical' | 'moderate' | 'minor'
  recurrenceCount: number                  // how many sessions this appeared in
  lastSeen: Date
  firstSeen: Date

  // Linked competencies affected by this weakness
  linkedCompetencies: string[]

  // Evidence from sessions
  evidence: Array<{
    sessionId: mongoose.Types.ObjectId
    questionIndex: number
    observation: string
    timestamp: Date
  }>

  // Whether user has been notified / acknowledged
  acknowledged: boolean

  createdAt: Date
  updatedAt: Date
}

const WeaknessClusterSchema = new Schema<IWeaknessCluster>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    weaknessName: { type: String, required: true },
    description: { type: String, default: '' },
    severity: { type: String, enum: ['critical', 'moderate', 'minor'], default: 'moderate' },
    recurrenceCount: { type: Number, default: 1 },
    lastSeen: { type: Date, default: Date.now },
    firstSeen: { type: Date, default: Date.now },

    linkedCompetencies: [{ type: String }],

    evidence: [{
      sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession' },
      questionIndex: { type: Number },
      observation: { type: String },
      timestamp: { type: Date, default: Date.now },
    }],

    acknowledged: { type: Boolean, default: false },
  },
  { timestamps: true }
)

WeaknessClusterSchema.index({ userId: 1, weaknessName: 1 }, { unique: true })
WeaknessClusterSchema.index({ userId: 1, severity: 1, recurrenceCount: -1 })

export const WeaknessCluster: Model<IWeaknessCluster> =
  mongoose.models.WeaknessCluster ||
  mongoose.model<IWeaknessCluster>('WeaknessCluster', WeaknessClusterSchema)
