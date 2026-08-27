import type { ClientSession } from 'mongoose'
import type mongoose from 'mongoose'
import {
  HireCandidateBulkOperation,
  HireCandidateBulkOperationItem,
} from './models'

/** Delete action items before their operation parents during hard purge. */
export async function deleteHireCandidateActionWorkspaceData(input: {
  workspaceId: mongoose.Types.ObjectId
  session: ClientSession
}): Promise<void> {
  if (!input.session.inTransaction()) {
    throw new Error('Hire candidate actions must be deleted inside workspace purge')
  }
  await HireCandidateBulkOperationItem.deleteMany(
    { workspaceId: input.workspaceId },
    { session: input.session },
  )
  await HireCandidateBulkOperation.deleteMany(
    { workspaceId: input.workspaceId },
    { session: input.session },
  )
}
