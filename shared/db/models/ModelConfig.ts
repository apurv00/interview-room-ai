import mongoose, { Schema, Document, Model } from 'mongoose'
import { TASK_SLOTS, TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'

// Re-export for backward compat
export { TASK_SLOTS, TASK_SLOT_DEFAULTS, type TaskSlot }

// ─── Schema ─────────────────────────────────────────────────────────────────

export interface IModelSlotConfig {
  taskSlot: TaskSlot
  /** Primary model ID — OpenRouter format (e.g. "anthropic/claude-sonnet-4-6") or Anthropic native */
  model: string
  /** Fallback model if primary fails or times out */
  fallbackModel?: string
  /** Max tokens for this slot */
  maxTokens: number
  /** Which provider to route through */
  provider: 'anthropic' | 'openrouter'
  /** Temperature override (0-1). Omit to use provider default. */
  temperature?: number
  /** Whether this slot is active. Inactive = use hardcoded default. */
  isActive: boolean
}

export interface IModelConfig extends Document {
  _id: mongoose.Types.ObjectId
  /** Global toggle: when false, all calls use hardcoded Anthropic defaults */
  openRouterEnabled: boolean
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
    fallbackModel: { type: String },
    maxTokens: { type: Number, required: true, min: 100, max: 16000 },
    provider: { type: String, required: true, enum: ['anthropic', 'openrouter'], default: 'anthropic' },
    temperature: { type: Number, min: 0, max: 2 },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
)

const ModelConfigSchema = new Schema<IModelConfig>(
  {
    openRouterEnabled: { type: Boolean, default: false },
    slots: { type: [ModelSlotConfigSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

// Singleton helper
ModelConfigSchema.statics.getConfig = async function (): Promise<IModelConfig | null> {
  return this.findOne().lean()
}

export const ModelConfig: IModelConfigModel =
  (mongoose.models.ModelConfig as IModelConfigModel) ||
  mongoose.model<IModelConfig, IModelConfigModel>('ModelConfig', ModelConfigSchema)
