import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, User } from '@shared/db/models'
import { deleteFromR2 } from '@shared/storage/r2'
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

    // SURVIVOR CHECK: a membership row is not proof of a living member.
    // Two members deleting in sequence used to leave the first one's row
    // behind, and the second deletion counted that ghost as a survivor —
    // skipping the cascade and orphaning the workspace and its candidate
    // PII permanently (Codex P1 on #619). Resolve the referenced Users and
    // require one that actually exists and is not itself deleting.
    const otherMembers = await HireWorkspaceMember.find({
      workspaceId,
      userId: { $exists: true, $ne: userObjectId },
    }).select('userId')
    const otherUserIds = otherMembers
      .map((m) => m.userId)
      .filter((id): id is mongoose.Types.ObjectId => !!id)
    const survivors = otherUserIds.length
      ? await User.countDocuments({
          _id: { $in: otherUserIds },
          accountState: { $ne: 'deleting' },
        })
      : 0
    if (survivors > 0) continue // the team keeps the workspace and its data

    // Collect the synthetic guests BEFORE anything that carries them is
    // removed — losing these ids means losing the only route to the
    // candidate recordings they own.
    const rounds = await HireRound.find({ workspaceId }).select('guestUserId')
    const guestUserIds = rounds
      .map((r) => r.guestUserId)
      .filter((id): id is mongoose.Types.ObjectId => !!id)

    // Guest artifacts FIRST, and R2 objects before the rows that inventory
    // them. Deleting a session row without its R2 keys leaves the
    // candidate's recording in object storage, undiscoverable from Mongo
    // and unreachable by any later sweep (Codex P1 on #619).
    if (guestUserIds.length > 0) {
      const guestSessions = await InterviewSession.find({
        userId: { $in: guestUserIds },
      }).select(
        '_id recordingR2Key audioRecordingR2Key screenRecordingR2Key facialLandmarksR2Key resumeR2Key jdR2Key',
      )
      const r2Keys = guestSessions.flatMap((session) =>
        [
          session.recordingR2Key,
          session.audioRecordingR2Key,
          session.screenRecordingR2Key,
          session.facialLandmarksR2Key,
          session.resumeR2Key,
          session.jdR2Key,
        ].filter((k): k is string => !!k),
      )
      for (const key of r2Keys) {
        // Fail LOUD: an object left behind is undeletable afterwards, so
        // the deletion must be reported incomplete rather than succeed.
        await deleteFromR2(key, { ownerUserId: String(userObjectId) })
      }
      cleared['R2 objects (hire guests)'] =
        (cleared['R2 objects (hire guests)'] ?? 0) + r2Keys.length

      const sessionRes = await InterviewSession.deleteMany({ userId: { $in: guestUserIds } })
      cleared['InterviewSession (hire guests)'] =
        (cleared['InterviewSession (hire guests)'] ?? 0) + (sessionRes.deletedCount ?? 0)
      const guestRes = await User.deleteMany({ _id: { $in: guestUserIds } })
      cleared['User (hire guests)'] = (cleared['User (hire guests)'] ?? 0) + (guestRes.deletedCount ?? 0)
    }

    // Workspace contents next. The membership rows and the workspace row
    // are the ANCHOR this function uses to rediscover the work, so they go
    // LAST: if any sweep above fails, the caller throws and the retry can
    // still find this workspace. Deleting the anchor first made a failed
    // run report success on retry while guest data survived (Codex P1 on
    // #619).
    const contentSweeps: Array<[string, Promise<{ deletedCount?: number }>]> = [
      ['HireRound', HireRound.deleteMany({ workspaceId })],
      ['HireApplication', HireApplication.deleteMany({ workspaceId })],
      ['HireCandidate', HireCandidate.deleteMany({ workspaceId })],
      ['HireJob', HireJob.deleteMany({ workspaceId })],
    ]
    for (const [name, op] of contentSweeps) {
      const res = await op
      cleared[name] = (cleared[name] ?? 0) + (res.deletedCount ?? 0)
    }

    const memberRes = await HireWorkspaceMember.deleteMany({ workspaceId })
    cleared['HireWorkspaceMember'] = (cleared['HireWorkspaceMember'] ?? 0) + (memberRes.deletedCount ?? 0)
    const wsRes = await HireWorkspace.deleteMany({ _id: workspaceId })
    cleared['HireWorkspace'] = (cleared['HireWorkspace'] ?? 0) + (wsRes.deletedCount ?? 0)
  }

  return cleared
}
