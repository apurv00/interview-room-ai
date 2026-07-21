import mongoose, { Schema, type Document, type Model } from 'mongoose'

export const JOB_SOURCE_CONTROL_META_ID = 'jobs-source-control'

/** Corpus-wide proof that the durable source-lineage migration completed.
 * Source revocation physically fences this singleton in the same transaction,
 * so a failed/rolled-back migration cannot enable the indexed legal path. */
export interface IJobSourceControlMeta extends Document<string> {
  _id: string
  sourceLineageVersion: number
  controlWriteSeq: number
  /** Corpus-wide ingest mutex. Every fenced posting-write transaction bumps
   * this before its per-source config fence, matching control's lock order. */
  ingestWriteSeq: number
  /** Exact at migration/source-run reconciliation and then monotonically
   * incremented for committed inserts. TTL deletion can only overstate it
   * until the next reconciliation, which is capacity-safe. */
  retainedPostings: number
  repairedAt: Date
  repairedPostings: number
  unknownLineagePostings: number
  createdAt: Date
  updatedAt: Date
}

const JobSourceControlMetaSchema = new Schema<IJobSourceControlMeta>(
  {
    _id: { type: String, required: true },
    sourceLineageVersion: { type: Number, required: true, min: 1 },
    controlWriteSeq: { type: Number, default: 0, min: 0 },
    ingestWriteSeq: { type: Number, default: 0, min: 0 },
    retainedPostings: { type: Number, required: true, min: 0 },
    repairedAt: { type: Date, required: true },
    repairedPostings: { type: Number, required: true, min: 0 },
    unknownLineagePostings: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
)

export const JobSourceControlMeta: Model<IJobSourceControlMeta> =
  mongoose.models.JobSourceControlMeta ||
  mongoose.model<IJobSourceControlMeta>('JobSourceControlMeta', JobSourceControlMetaSchema)
