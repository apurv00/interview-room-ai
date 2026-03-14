import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IWizardConfig extends Document {
  _id: mongoose.Types.ObjectId
  costCapEnabled: boolean
  costCapUsd: number
  updatedBy?: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

interface IWizardConfigModel extends Model<IWizardConfig> {
  getConfig(): Promise<{ costCapEnabled: boolean; costCapUsd: number }>
}

const WizardConfigSchema = new Schema<IWizardConfig>(
  {
    costCapEnabled: { type: Boolean, default: true },
    costCapUsd: { type: Number, default: 1.0, min: 0.01, max: 100 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
)

// Singleton helper — returns the single config doc or defaults
WizardConfigSchema.statics.getConfig = async function (): Promise<{ costCapEnabled: boolean; costCapUsd: number }> {
  const doc = await this.findOne().lean()
  if (doc) {
    return { costCapEnabled: doc.costCapEnabled, costCapUsd: doc.costCapUsd }
  }
  return { costCapEnabled: true, costCapUsd: 1.0 }
}

export const WizardConfig: IWizardConfigModel =
  (mongoose.models.WizardConfig as IWizardConfigModel) ||
  mongoose.model<IWizardConfig, IWizardConfigModel>('WizardConfig', WizardConfigSchema)
