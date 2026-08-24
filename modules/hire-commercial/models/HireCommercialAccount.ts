import mongoose, { Document, Model, Schema } from 'mongoose'
import {
  HIRE_COMMERCIAL_CATALOG_VERSION,
  HIRE_COMMERCIAL_MODULE_IDS,
  type HireCommercialModuleId,
} from '../catalog'

export type HireCommercialPilotStatus =
  | 'not_requested'
  | 'requested'
  | 'active'

export interface IHireCommercialAccount extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  catalogVersion: typeof HIRE_COMMERCIAL_CATALOG_VERSION
  entitledModules: HireCommercialModuleId[]
  pilotStatus: HireCommercialPilotStatus
  createdAt: Date
  updatedAt: Date
}

const HireCommercialAccountSchema = new Schema<IHireCommercialAccount>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    catalogVersion: {
      type: String,
      enum: [HIRE_COMMERCIAL_CATALOG_VERSION],
      required: true,
      default: HIRE_COMMERCIAL_CATALOG_VERSION,
    },
    entitledModules: {
      type: [{ type: String, enum: HIRE_COMMERCIAL_MODULE_IDS }],
      default: ['core'],
      set: (values: HireCommercialModuleId[]) =>
        Array.from(new Set<HireCommercialModuleId>(['core', ...values])),
    },
    pilotStatus: {
      type: String,
      enum: ['not_requested', 'requested', 'active'],
      required: true,
      default: 'not_requested',
    },
  },
  {
    timestamps: true,
    strict: 'throw',
    // This rollout's unique workspace index is owned by the explicit Phase 2
    // preparer. Runtime model initialization must never race its preflight.
    autoCreate: false,
    autoIndex: false,
  },
)

export const HireCommercialAccount: Model<IHireCommercialAccount> =
  mongoose.models.HireCommercialAccount ||
  mongoose.model<IHireCommercialAccount>(
    'HireCommercialAccount',
    HireCommercialAccountSchema,
  )
