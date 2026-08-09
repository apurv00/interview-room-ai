import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, User } from '@shared/db/models'
import {
  HireWorkspace,
  HireWorkspaceMember,
  HireJob,
  HireCandidate,
  HireApplication,
  HireRound,
} from '../models'

/**
 * Delete every hire workspace that a departing member leaves ORPHANED,
 * and everything inside it.
 *
 * Hire data belongs to the WORKSPACE, not to whichever member closes their
 * account — one recruiter leaving must never delete their team's pipeline,
 * which is why apply-page writes resolve a live workspace authority rather
 * than binding to a creator. But when the LAST member holding an account
 * goes, the workspace goes with them (founder ruling 2026-08-09):
 * otherwise it strands third-party PII — résumés, transcripts and
 * interview recordings belonging to candidates who never had an account
 * here and have no way to reach us.
 *
 * "Last member" means no OTHER member row is linked to a surviving user.
 * An un-accepted invite deliberately does not keep a workspace — and its
 * candidates' personal data — alive indefinitely.
 *
 * Guest interview data is swept explicitly: each AI round mints a
 * synthetic per-round user whose InterviewSession holds the candidate's
 * transcript and recording keys. Those are the most sensitive rows in the
 * set and are keyed by that synthetic id, so a userId-keyed pass over the
 * departing member would never reach them.
 *
 * Lives in modules/hire because these collections do; the account-deletion
 * service reaches it through a dynamic import so that shared/ keeps no
 * static dependency on a module.
 */
export async function deleteOrphanedWorkspacesForUser(
  userId: string | mongoose.Types.ObjectId,
): Promise<Record<string, number>> {
  await connectDB()
  const userObjectId =
    typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId
  const cleared: Record<string, number> = {}

  const memberships = await HireWorkspaceMember.find({ userId: userObjectId }).select(
    'workspaceId',
  )

  for (const membership of memberships) {
    const workspaceId = membership.workspaceId
    const survivors = await HireWorkspaceMember.countDocuments({
      workspaceId,
      userId: { $exists: true, $ne: userObjectId },
    })
    if (survivors > 0) continue // the team keeps the workspace and its data

    // Collect the synthetic guests BEFORE their rounds are removed.
    const rounds = await HireRound.find({ workspaceId }).select('guestUserId')
    const guestUserIds = rounds
      .map((r) => r.guestUserId)
      .filter((id): id is mongoose.Types.ObjectId => !!id)

    const sweeps: Array<[string, Promise<{ deletedCount?: number }>]> = [
      ['HireRound', HireRound.deleteMany({ workspaceId })],
      ['HireApplication', HireApplication.deleteMany({ workspaceId })],
      ['HireCandidate', HireCandidate.deleteMany({ workspaceId })],
      ['HireJob', HireJob.deleteMany({ workspaceId })],
      ['HireWorkspaceMember', HireWorkspaceMember.deleteMany({ workspaceId })],
      ['HireWorkspace', HireWorkspace.deleteMany({ _id: workspaceId })],
    ]
    if (guestUserIds.length > 0) {
      sweeps.push([
        'InterviewSession (hire guests)',
        InterviewSession.deleteMany({ userId: { $in: guestUserIds } }),
      ])
      sweeps.push(['User (hire guests)', User.deleteMany({ _id: { $in: guestUserIds } })])
    }

    for (const [name, op] of sweeps) {
      const res = await op
      cleared[name] = (cleared[name] ?? 0) + (res.deletedCount ?? 0)
    }
  }

  return cleared
}
