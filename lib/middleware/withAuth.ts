import { getServerSession } from 'next-auth'
import { NextRequest, NextResponse } from 'next/server'
import { authOptions } from '@/lib/auth/authOptions'

export interface AuthUser {
  id: string
  role: string
  organizationId?: string
  plan: string
  email: string
}

export type AuthenticatedHandler = (
  req: NextRequest,
  context: { params: Record<string, string> },
  user: AuthUser
) => Promise<NextResponse>

export function withAuth(handler: AuthenticatedHandler) {
  return async (req: NextRequest, context: { params: Record<string, string> }) => {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return handler(req, context, {
      id: session.user.id,
      role: session.user.role,
      organizationId: session.user.organizationId,
      plan: session.user.plan,
      email: session.user.email,
    })
  }
}
