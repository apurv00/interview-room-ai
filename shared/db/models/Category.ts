import mongoose, { Schema, Document, Model } from 'mongoose'

/**
 * Category — first-class top-level bucket for the interview-domain taxonomy.
 *
 * Replaces the four hardcoded, drifting `category` lists (the dead Mongoose
 * enum on InterviewDomain, the seed strings, DomainSelector's CATEGORY_TABS,
 * and the CMS form options) with one storage source of truth. A domain points
 * at a category via `InterviewDomain.categorySlug`.
 *
 * `parentSlug` is reserved for future sub-categories (e.g. Engineering →
 * Mechanical/Civil as nested groups); flat for now.
 */
export interface ICategory extends Document {
  _id: mongoose.Types.ObjectId
  slug: string
  label: string
  icon: string
  /** One-liner shown under the category card on the setup grid. */
  description: string
  /** Reserved for future nesting; null/undefined = top-level. */
  parentSlug?: string
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

const CategorySchema = new Schema<ICategory>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    icon: { type: String, default: '🗂' },
    description: { type: String, default: '' },
    parentSlug: { type: String, default: null },
    isBuiltIn: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
)

CategorySchema.index({ isActive: 1, sortOrder: 1 })

export const Category: Model<ICategory> =
  mongoose.models.Category || mongoose.model<ICategory>('Category', CategorySchema)
