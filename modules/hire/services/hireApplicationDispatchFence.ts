import type { ClientSession } from 'mongoose'
import mongoose from 'mongoose'
import { AppError } from '@shared/errors'
import { HireApplication, TERMINAL_STAGES } from '../models'

/**
 * Serialize interview creation and provider egress against a recruiter's
 * terminal stage decision.
 *
 * A stage move writes the application document in its own workspace
 * transaction. Each invitation authorization writes this same document with a
 * non-terminal predicate in its transaction. Mongo therefore retries the
 * losing transaction: when a terminal move commits first, the retry cannot
 * claim this fence and no round or email can be authorized. We deliberately
 * do not hold a transaction across the email provider call; the committed
 * fence claim is the linearization point for that external side effect.
 */
export async function claimNonTerminalHireApplicationDispatchFence(input: {
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  now: Date
  session: ClientSession
}): Promise<void> {
  const claim = await HireApplication.updateOne(
    {
      _id: input.applicationId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      candidateId: input.candidateId,
      stage: { $nin: TERMINAL_STAGES },
    },
    // `updatedAt` is an existing, schema-owned field. Updating it gives this
    // authorization a document-write conflict with `moveStage` without adding
    // mutable decision state or touching the interview engine/B2C database.
    { $set: { updatedAt: input.now } },
    { session: input.session, timestamps: false },
  )
  if (claim.matchedCount !== 1) {
    throw new AppError(
      'The application is no longer eligible for an interview invitation',
      409,
      'APPLICATION_NOT_ELIGIBLE',
    )
  }
}
