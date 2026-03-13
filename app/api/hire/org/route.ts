import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User, Organization } from '@shared/db/models'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const CreateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: z.string().min(2).max(50).trim().toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  domain: z.string().max(200).optional(),
})

const UpdateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  settings: z.object({
    allowedRoles: z.array(z.string()).optional(),
    defaultDuration: z.union([z.literal(10), z.literal(20), z.literal(30)]).optional(),
    requireRecording: z.boolean().optional(),
    customWelcomeMessage: z.string().max(500).optional(),
    webhookUrl: z.string().url().max(500).optional().or(z.literal('')),
  }).optional(),
})

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = CreateOrgSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data', details: parsed.error.flatten() }, { status: 400 })
  }

  await connectDB()

  const user = await User.findById(session.user.id).lean()
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (user.organizationId) return NextResponse.json({ error: 'Already in an organization' }, { status: 400 })

  // Check slug uniqueness
  const existing = await Organization.findOne({ slug: parsed.data.slug }).lean()
  if (existing) {
    return NextResponse.json({ error: 'Organization slug already taken' }, { status: 409 })
  }

  const org = await Organization.create({
    name: parsed.data.name,
    slug: parsed.data.slug,
    domain: parsed.data.domain,
    createdBy: user._id,
    plan: 'starter',
    maxSeats: 5,
    currentSeats: 1,
    monthlyInterviewLimit: 100,
  })

  // Update user to be org_admin
  await User.findByIdAndUpdate(session.user.id, {
    $set: { organizationId: org._id, role: 'org_admin' },
  })

  return NextResponse.json({
    success: true,
    organization: {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
    },
  })
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('organizationId role').lean()
  if (!user?.organizationId) {
    return NextResponse.json({ organization: null })
  }

  const org = await Organization.findById(user.organizationId).lean()
  if (!org) {
    return NextResponse.json({ organization: null })
  }

  // Count team members
  const teamCount = await User.countDocuments({ organizationId: org._id })

  return NextResponse.json({
    organization: {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      domain: org.domain,
      plan: org.plan,
      maxSeats: org.maxSeats,
      currentSeats: teamCount,
      monthlyInterviewLimit: org.monthlyInterviewLimit,
      monthlyInterviewsUsed: org.monthlyInterviewsUsed,
      settings: org.settings,
    },
  })
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = UpdateOrgSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  await connectDB()
  const user = await User.findById(session.user.id).select('organizationId role').lean()
  if (!user?.organizationId || !['org_admin', 'platform_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const update: Record<string, unknown> = {}
  if (parsed.data.name) update.name = parsed.data.name
  if (parsed.data.settings) {
    for (const [key, val] of Object.entries(parsed.data.settings)) {
      if (val !== undefined) update[`settings.${key}`] = val
    }
  }

  await Organization.findByIdAndUpdate(user.organizationId, { $set: update })

  return NextResponse.json({ success: true })
}
