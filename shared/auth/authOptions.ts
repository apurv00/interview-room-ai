import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import GitHubProvider from 'next-auth/providers/github'
import CredentialsProvider from 'next-auth/providers/credentials'
import { MongoDBAdapter } from '@auth/mongodb-adapter'
import type { Adapter } from 'next-auth/adapters'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import clientPromise from '@shared/db/mongoClient'
import { authLogger } from '@shared/logger'
import { resolveFirstPartyAuthRedirect } from './redirect'

const isHireRuntime = process.env.IPG_SURFACE === 'hire-engine'
const authSecret = isHireRuntime
  ? process.env.HIRE_RUNTIME_NEXTAUTH_SECRET
  : process.env.NEXTAUTH_SECRET

// Fail fast if NEXTAUTH_SECRET is missing or too short in production.
// Without a proper secret, JWTs can be forged and sessions hijacked.
// Guard with typeof window check to avoid breaking build-time page collection.
if (
  typeof globalThis !== 'undefined' &&
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PHASE &&
  (!authSecret || authSecret.length < 16)
) {
  throw new Error(
    `${isHireRuntime ? 'HIRE_RUNTIME_NEXTAUTH_SECRET' : 'NEXTAUTH_SECRET'} must be set to a strong value (>= 16 chars) in production. Generate one with: openssl rand -base64 32`,
  )
}

export const authOptions: NextAuthOptions = {
  adapter: MongoDBAdapter(clientPromise) as Adapter,
  secret: authSecret,

  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },

  providers: [
    ...(!isHireRuntime && process.env.GOOGLE_CLIENT_ID
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            authorization: {
              params: {
                prompt: 'select_account',
              },
            },
          }),
        ]
      : []),
    ...(!isHireRuntime && process.env.GITHUB_CLIENT_ID
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
          }),
        ]
      : []),
    // Candidate invite OTP. The `ticket` credential is minted by
    // /api/invite/[sessionId]/verify-otp after a successful OTP check; this
    // provider's only job is to redeem the ticket and hand NextAuth a user
    // record so the session cookie gets issued. No passwords, no form fields.
    CredentialsProvider({
      id: 'invite-otp',
      name: 'Interview invite',
      credentials: {
        ticket: { label: 'Ticket', type: 'text' },
      },
      async authorize(credentials) {
        const ticket = credentials?.ticket
        if (!ticket || typeof ticket !== 'string') return null

        const payload = isHireRuntime
          ? await import(
              '@modules/hire-runtime/services/handoffAuthTicketService'
            ).then(({ redeemRuntimeAuthTicket }) =>
              redeemRuntimeAuthTicket(ticket),
            )
          : await import('@b2b/services/inviteTicketService').then(
              ({ redeemAuthTicket }) => redeemAuthTicket(ticket),
            )
        if (!payload) {
          authLogger.warn('invite-otp: ticket redemption failed')
          return null
        }
        if (isHireRuntime && !payload.organizationId) {
          authLogger.warn(
            { userId: payload.userId },
            'invite-otp: runtime ticket is missing its workspace boundary',
          )
          return null
        }

        try {
          await connectDB()
          const userQuery = isHireRuntime
            ? User.findOne({
                _id: payload.userId,
                organizationId: payload.organizationId,
              })
            : User.findById(payload.userId)
          const dbUser = await userQuery.select(
            '_id email name image',
          )
          if (!dbUser) {
            authLogger.error(
              { userId: payload.userId },
              'invite-otp: user vanished between ticket issue and redemption',
            )
            return null
          }
          const authorizedUser = {
            id: dbUser._id.toString(),
            email: dbUser.email,
            name: dbUser.name ?? dbUser.email,
            image: dbUser.image ?? undefined,
            ...(isHireRuntime
              ? { organizationId: payload.organizationId }
              : {}),
          }
          return authorizedUser
        } catch (err) {
          authLogger.error({ err }, 'invite-otp: user lookup failed')
          return null
        }
      },
    }),
  ],

  callbacks: {
    async redirect({ url, baseUrl }) {
      return resolveFirstPartyAuthRedirect(url, baseUrl, isHireRuntime)
    },

    async signIn({ user, account }) {
      authLogger.info({
        provider: account?.provider,
        email: user.email,
        userId: user.id,
      }, 'Sign-in attempt')

      if (!user.email || typeof user.email !== 'string') {
        authLogger.warn(
          { provider: account?.provider, userId: user.id },
          'Sign-in blocked: no email on account (GitHub private email?)',
        )
        return false
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(user.email)) {
        authLogger.warn(
          { provider: account?.provider, email: user.email },
          'Sign-in blocked: malformed email',
        )
        return false
      }

      return true
    },

    async jwt({ token, user, account, trigger, session }) {
      if (user) {
        await connectDB()
        const runtimeUser = user as typeof user & { organizationId?: string }
        if (isHireRuntime && !runtimeUser.organizationId) {
          authLogger.error(
            { userId: user.id },
            'Runtime JWT issuance refused without a workspace boundary',
          )
          throw new Error('Runtime identity is missing its workspace boundary')
        }
        const dbUser = isHireRuntime
          ? await User.findOne({
              _id: user.id,
              organizationId: runtimeUser.organizationId,
            })
          : await User.findOne({ email: user.email })
        if (isHireRuntime && !dbUser) {
          authLogger.error(
            { userId: user.id, organizationId: runtimeUser.organizationId },
            'Runtime JWT issuance refused for an unknown workspace principal',
          )
          throw new Error('Runtime workspace principal is unavailable')
        }
        if (dbUser) {
          token.userId = dbUser._id.toString()
          token.role = dbUser.role
          token.organizationId = dbUser.organizationId?.toString()
          token.plan = dbUser.plan
        }
        // Store provider info for debugging
        if (account) {
          token.provider = account.provider
        }
      }
      // Plan/role/onboarding are snapshot at sign-in and only re-read on
      // explicit `useSession().update()` (handled below). The periodic 5-min
      // Mongo refresh that used to live here was removed because it
      // blocked every authed request — including /api/tts/stream — on
      // Mongo cold-start for up to 5s, producing mid-interview dead-air
      // at Q4/Q6 (first requests after the 5-min throttle boundary).
      // Consequence: external plan/role mutations (admin demotion,
      // Stripe upgrade when wired) only propagate on next sign-in or an
      // explicit client-side update() call. Acceptable today: Stripe is
      // not integrated, role revocations are rare, and interview-limit
      // enforcement uses an atomic DB check, not the JWT plan field.
      // When session update is triggered (e.g. after plan change, onboarding),
      // always re-read authoritative fields from the database instead of trusting
      // client-supplied values. This prevents privilege escalation via
      // NextAuth's update() API.
      if (trigger === 'update' && token.userId) {
        try {
          await connectDB()
          const runtimeOrganizationId =
            typeof token.organizationId === 'string'
              ? token.organizationId
              : undefined
          if (isHireRuntime && !runtimeOrganizationId) {
            throw new Error('Runtime session is missing its workspace boundary')
          }
          const userQuery = isHireRuntime
            ? User.findOne({
                _id: token.userId,
                organizationId: runtimeOrganizationId,
              })
            : User.findById(token.userId)
          const dbUser = await userQuery.select('plan role organizationId')
          if (isHireRuntime && !dbUser) {
            throw new Error('Runtime workspace principal is unavailable')
          }
          if (dbUser) {
            token.role = dbUser.role
            token.plan = dbUser.plan
            token.organizationId = dbUser.organizationId?.toString()
            token.lastRefreshedAt = Date.now()
          }
        } catch (err) {
          authLogger.error({ err, userId: token.userId }, 'JWT session-update refresh failed — keeping stale token')
          if (isHireRuntime) throw err
        }
      }
      return token
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string
        session.user.role = (token.role as string) || 'candidate'
        session.user.organizationId = token.organizationId as string | undefined
        session.user.plan = (token.plan as string) || 'free'
      }
      return session
    },
  },

  cookies: isHireRuntime
    ? {
        sessionToken: {
          name:
            process.env.NODE_ENV === 'production'
              ? '__Secure-ipg-hire-runtime'
              : 'ipg-hire-runtime',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: process.env.NODE_ENV === 'production',
            // Host-only by design: never add Domain here.
          },
        },
      }
    : process.env.NODE_ENV === 'production'
      ? {
          sessionToken: {
            name: '__Secure-next-auth.session-token',
            options: {
              httpOnly: true,
              sameSite: 'lax',
              path: '/',
              secure: true,
              domain: '.interviewprep.guru',
            },
          },
        }
      : undefined,

  pages: {
    signIn: isHireRuntime ? '/handoff' : '/signin',
    error: isHireRuntime ? '/handoff' : '/signin',
  },

  events: isHireRuntime ? {} : {
    async createUser({ user }) {
      try {
        if (!user.email) {
          authLogger.error(
            { userId: user.id, name: user.name },
            'createUser event: no email — cannot create Mongoose User record',
          )
          return
        }

        await connectDB()
        const existing = await User.findOne({ email: user.email })
        if (!existing) {
          await User.create({
            email: user.email,
            name: user.name || user.email.split('@')[0] || 'User',
            image: user.image ?? undefined,
            emailVerified: new Date(),
            role: 'candidate',
            plan: 'free',
            monthlyInterviewLimit: 1,
          })
        }
      } catch (err) {
        authLogger.error(
          { err, email: user.email, userId: user.id },
          'createUser event failed — user session may lack app-level data until next sign-in',
        )
      }
    },
  },
}
