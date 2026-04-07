import mongoose, { Schema, Document, Model } from 'mongoose'

export interface IWaitlistEntry extends Document {
  _id: mongoose.Types.ObjectId
  email: string
  source: string
  createdAt: Date
  updatedAt: Date
}

const WaitlistEntrySchema = new Schema<IWaitlistEntry>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    source: { type: String, required: true, trim: true },
  },
  { timestamps: true }
)

export const WaitlistEntry: Model<IWaitlistEntry> =
  (mongoose.models.WaitlistEntry as Model<IWaitlistEntry>) ||
  mongoose.model<IWaitlistEntry>('WaitlistEntry', WaitlistEntrySchema)
