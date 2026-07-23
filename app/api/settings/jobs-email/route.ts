import mongoose, { type ClientSession } from 'mongoose'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import {
  activeJobsAccountFilter,
  JobsAccountInactiveError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

const MANAGED_STREAMS = ['e0', 'e1', 'e2', 'e4'] as const
const SUPPRESSION_ORDER = ['e0', 'e1', 'e2', 'e3', 'e4', 'all'] as const
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const QUIET_HOURS = {
  label: '08:00 until 21:00 IST',
  timezone: 'Asia/Kolkata',
} as const

const EnabledSchema = z.object({
  e0: z.boolean(),
  e1: z.boolean(),
  e2: z.boolean(),
  e4: z.boolean(),
}).strict()

const EnabledPatchSchema = EnabledSchema
  .partial()
  .refine((enabled) => Object.keys(enabled).length > 0)

const UpdateJobsEmailSchema = z.object({ enabled: EnabledPatchSchema }).strict()

type JobsEmailEnabled = z.infer<typeof EnabledSchema>

interface JobsEmailPreferencesRecord {
  emailPreferences?: {
    jobs?: {
      nudges?: boolean
      unsubscribedStreams?: string[]
    }
  }
}

function accountUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
  )
}

function preferencesResponse(enabled: JobsEmailEnabled): NextResponse {
  return NextResponse.json(
    { enabled, quietHours: QUIET_HOURS },
    { headers: PRIVATE_NO_STORE_HEADERS },
  )
}

function enabledFromPreferences(record: JobsEmailPreferencesRecord): JobsEmailEnabled {
  const jobs = record.emailPreferences?.jobs
  const suppressed = new Set(
    Array.isArray(jobs?.unsubscribedStreams) ? jobs.unsubscribedStreams : [],
  )
  const allSuppressed = suppressed.has('all')
  const nudgesEnabled = jobs?.nudges !== false
  const streamEnabled = (stream: typeof MANAGED_STREAMS[number]) =>
    !allSuppressed && !suppressed.has(stream)

  return {
    e0: streamEnabled('e0'),
    e1: nudgesEnabled && streamEnabled('e1'),
    e2: streamEnabled('e2'),
    e4: nudgesEnabled && streamEnabled('e4'),
  }
}

function nextSuppressions(
  current: string[] | undefined,
  enabled: JobsEmailEnabled,
): string[] {
  const suppressions = new Set<string>()
  if (MANAGED_STREAMS.every((stream) => !enabled[stream])) {
    suppressions.add('all')
  } else {
    for (const stream of MANAGED_STREAMS) {
      if (!enabled[stream]) suppressions.add(stream)
    }
  }

  // E3 is retired from the active contract. Retain suppression recorded by
  // legacy links so this settings write never revives historical consent.
  if (current?.includes('e3') || current?.includes('all')) suppressions.add('e3')
  return SUPPRESSION_ORDER.filter((stream) => suppressions.has(stream))
}

async function readCurrentPreferences(
  userId: string,
  session?: ClientSession,
): Promise<JobsEmailPreferencesRecord | null> {
  return User.findOne(activeJobsAccountFilter(userId), undefined, session ? { session } : undefined)
    .select('emailPreferences.jobs')
    .lean<JobsEmailPreferencesRecord>()
}

export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  await connectDB()
  if (!mongoose.Types.ObjectId.isValid(userId)) return accountUnavailableResponse()

  const current = await readCurrentPreferences(userId)
  if (!current) return accountUnavailableResponse()
  return preferencesResponse(enabledFromPreferences(current))
}

export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'invalid jobs email preferences', code: 'INVALID_JOBS_EMAIL_PREFERENCES' },
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
  const parsed = UpdateJobsEmailSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid jobs email preferences', code: 'INVALID_JOBS_EMAIL_PREFERENCES' },
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }

  await connectDB()
  try {
    const enabled = await withActiveJobsAccountWrite(userId, async (dbSession) => {
      const current = await readCurrentPreferences(userId, dbSession)
      if (!current) throw new JobsAccountInactiveError(userId)
      const nextEnabled = {
        ...enabledFromPreferences(current),
        ...parsed.data.enabled,
      }

      await User.updateOne(
        activeJobsAccountFilter(userId),
        {
          $set: {
            'emailPreferences.jobs.unsubscribedStreams': nextSuppressions(
              current.emailPreferences?.jobs?.unsubscribedStreams,
              nextEnabled,
            ),
            'emailPreferences.jobs.nudges': nextEnabled.e1 || nextEnabled.e4,
          },
        },
        { session: dbSession },
      )
      return nextEnabled
    })
    return preferencesResponse(enabled)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return accountUnavailableResponse()
    }
    throw error
  }
}
