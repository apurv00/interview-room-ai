import mongoose, { Schema, Document, Model } from 'mongoose'
import { TASK_SLOTS, TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'

// Re-export for backward compat
export { TASK_SLOTS, TASK_SLOT_DEFAULTS, type TaskSlot }

// ─── Schema ─────────────────────────────────────────────────────────────────

export interface IModelSlotConfig {
  taskSlot: TaskSlot
  /** Primary model ID (e.g. "claude-haiku-4-5-20251001", "gpt-4.1-mini", "gemini-2.5-flash") */
  model: string
  /** Primary provider (e.g. "anthropic", "openai", "openrouter", "google", "groq") */
  provider: string
  /** Fallback model if primary fails */
  fallbackModel?: string
  /** Fallback provider — can differ from primary for cross-provider fallback */
  fallbackProvider?: string
  /** Max tokens for this slot */
  maxTokens: number
  /** Temperature override (0-2). Omit to use provider default. */
  temperature?: number
  /** Whether this slot is active. Inactive = use hardcoded default. */
  isActive: boolean
  /** When true, structured contextData is TOON-encoded instead of JSON. */
  useToonInput: boolean
}

export interface IModelConfig extends Document {
  _id: mongoose.Types.ObjectId
  /** Global toggle: when false, all calls use hardcoded Anthropic defaults */
  routingEnabled: boolean
  slots: IModelSlotConfig[]
  updatedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

interface IModelConfigModel extends Model<IModelConfig> {
  getConfig(): Promise<IModelConfig | null>
}

const ModelSlotConfigSchema = new Schema<IModelSlotConfig>(
  {
    taskSlot: { type: String, required: true, enum: TASK_SLOTS },
    model: { type: String, required: true },
    provider: { type: String, required: true, default: 'anthropic' },
    fallbackModel: { type: String },
    fallbackProvider: { type: String },
    maxTokens: { type: Number, required: true, min: 100, max: 16000 },
    temperature: { type: Number, min: 0, max: 2 },
    isActive: { type: Boolean, default: true },
    useToonInput: { type: Boolean, default: false },
  },
  { _id: false }
)

const ModelConfigSchema = new Schema<IModelConfig>(
  {
    routingEnabled: { type: Boolean, default: false },
    slots: { type: [ModelSlotConfigSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

ModelConfigSchema.statics.getConfig = async function (): Promise<IModelConfig | null> {
  return this.findOne().lean()
}

export const ModelConfig: IModelConfigModel =
  (mongoose.models.ModelConfig as IModelConfigModel) ||
  mongoose.model<IModelConfig, IModelConfigModel>('ModelConfig', ModelConfigSchema)
