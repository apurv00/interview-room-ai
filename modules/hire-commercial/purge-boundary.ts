import type mongoose from 'mongoose'
import type { ClientSession } from 'mongoose'
import { HireCommercialAccount } from './models'

/** Delete commercial children in the caller-owned workspace purge transaction. */
export async function deleteHireCommercialWorkspaceData(input: {
  workspaceId: mongoose.Types.ObjectId
  session: ClientSession
}): Promise<void> {
  if (!input.session.inTransaction()) {
    throw new Error('Hire commercial data must be deleted inside workspace purge')
  }
  await HireCommercialAccount.deleteMany(
    { workspaceId: input.workspaceId },
    { session: input.session },
  )
}
