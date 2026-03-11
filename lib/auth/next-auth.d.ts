import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name: string
      image?: string
      role: string
      organizationId?: string
      plan: string
      onboardingCompleted: boolean
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId: string
    role: string
    organizationId?: string
    plan: string
    onboardingCompleted: boolean
  }
}
