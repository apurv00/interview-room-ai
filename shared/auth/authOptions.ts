import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import GitHubProvider from 'next-auth/providers/github'
import { MongoDBAdapter } from '@auth/mongodb-adapter'
import type { Adapter } from 'next-auth/adapters'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import clientPromise from '@shared/db/mongoClient'

// Fail fast if NEXTAUTH_SECRET is missing or too short in production.
// Without a proper secret, JWTs can be forged and sessions hijacked.
// Guard with typeof window check to avoid breaking build-time page collection.
if (
  typeof globalThis !== 'undefined' &&
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PHASE &&
  (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET.length < 16)
) {
  throw new Error('NEXTAUTH_SECRET must be set to a strong value (>= 16 chars) in production. Generate one with: openssl rand -base64 32')
}

export const authOptions: NextAuthOptions = {
  adapter: MongoDBAdapter(clientPromise) as Adapter,
  secret: process.env.NEXTAUTH_SECRET,

  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },

  providers: [
    ...(process.env.GOOGLE_CLIENT_ID
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
    ...(process.env.GITHUB_CLIENT_ID
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
          }),
        ]
      : []),
  ],

  callbacks: {
    async signIn({ user, account }) {
      // Audit log every sign-in attempt for debugging identity issues
      console.log('[AUTH] Sign-in attempt', {
        provider: account?.provider,
        email: user.email,
        userId: user.id,
      })
      return true
    },

    async jwt({ token, user, account, trigger, session }) {
      if (user) {
        await connectDB()
        const dbUser = await User.findOne({ email: user.email })
        if (dbUser) {
          token.userId = dbUser._id.toString()
          token.role = dbUser.role
          token.organizationId = dbUser.organizationId?.toString()
          token.plan = dbUser.plan
          token.onboardingCompleted = dbUser.onboardingCompleted ?? false
        }
        // Store provider info for debugging
        if (account) {
          token.provider = account.provider
        }
      }
      // Refresh plan from DB periodically (catches external plan changes).
      // Throttled to at most once every 5 minutes to avoid DB load.
      if (!user && token.userId) {
        const REFRESH_INTERVAL_MS = 5 * 60 * 1000
        const lastRefreshed = (token.lastRefreshedAt as number) || 0
        if (Date.now() - lastRefreshed > REFRESH_INTERVAL_MS) {
          try {
            await connectDB()
            const dbUser = await User.findById(token.userId).select('plan role onboardingCompleted')
            if (dbUser) {
              token.plan = dbUser.plan
              token.role = dbUser.role
              token.onboardingCompleted = dbUser.onboardingCompleted ?? false
            }
            token.lastRefreshedAt = Date.now()
          } catch {
            // Silently fail — keep existing token values
          }
        }
      }
      // When session update is triggered (e.g. after plan change, onboarding),
      // always re-read authoritative fields from the database instead of trusting
      // client-supplied values. This prevents privilege escalation via
      // NextAuth's update() API.
      if (trigger === 'update' && token.userId) {
        try {
          await connectDB()
          const dbUser = await User.findById(token.userId).select('plan role organizationId onboardingCompleted')
          if (dbUser) {
            token.role = dbUser.role
            token.plan = dbUser.plan
            token.organizationId = dbUser.organizationId?.toString()
            token.onboardingCompleted = dbUser.onboardingCompleted ?? false
            token.lastRefreshedAt = Date.now()
          }
        } catch {
          // Keep existing token values on DB failure
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
        session.user.onboardingCompleted = token.onboardingCompleted ?? false
      }
      return session
    },
  },

  cookies:
    process.env.NODE_ENV === 'production'
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
    signIn: '/signin',
    error: '/signin',
  },

  events: {
    async createUser({ user }) {
      await connectDB()
      const existing = await User.findOne({ email: user.email ?? undefined })
      if (!existing) {
        await User.create({
          email: user.email ?? '',
          name: user.name || user.email?.split('@')[0] || 'User',
          image: user.image ?? undefined,
          emailVerified: new Date(),
          role: 'candidate',
          plan: 'free',
          monthlyInterviewLimit: 999999,
          onboardingCompleted: false,
        })
      }
    },
  },
}
