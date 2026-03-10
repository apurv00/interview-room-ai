import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign In',
  description: 'Sign in to Interview Prep Guru to access your mock interviews and progress.',
  alternates: { canonical: '/signin' },
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
