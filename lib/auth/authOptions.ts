import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import GitHubProvider from 'next-auth/providers/github'
import CredentialsProvider from 'next-auth/providers/credentials'
import { MongoDBAdapter } from '@auth/mongodb-adapter'
import type { Adapter } from 'next-auth/adapters'
import bcrypt from 'bcryptjs'
import { connectDB } from '@/lib/db/connection'
import { User } from '@/lib/db/models'
import clientPromise from '@/lib/db/mongoClient'

export const authOptions: NextAuthOptions = {
  adapter: MongoDBAdapter(clientPromise) as Adapter,

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
    CredentialsProvider({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        await connectDB()
        const user = await User.findOne({ email: credentials.email.toLowerCase() })
        if (!user || !user.hashedPassword) return null

        const valid = await bcrypt.compare(credentials.password, user.hashedPassword)
        if (!valid) return null

        return {
          id: user._id.toString(),
          email: user.email ?? undefined,
          name: user.name,
          image: user.image,
        }
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        await connectDB()
        const dbUser = await User.findOne({ email: user.email })
        if (dbUser) {
          token.userId = dbUser._id.toString()
          token.role = dbUser.role
          token.organizationId = dbUser.organizationId?.toString()
          token.plan = dbUser.plan
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
            const dbUser = await User.findById(token.userId).select('plan role')
            if (dbUser) {
              token.plan = dbUser.plan
              token.role = dbUser.role
            }
            token.lastRefreshedAt = Date.now()
          } catch {
            // Silently fail — keep existing token values
          }
        }
      }
      if (trigger === 'update' && session) {
        token.role = session.role ?? token.role
        token.organizationId = session.organizationId ?? token.organizationId
        token.plan = session.plan ?? token.plan
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
          monthlyInterviewLimit: 3,
        })
      }
    },
  },
}
