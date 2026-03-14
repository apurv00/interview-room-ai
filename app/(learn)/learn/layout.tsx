import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: { default: 'Learn & Practice | Interview Prep Guru', template: '%s | Learn & Practice' },
  description: 'Master your interview skills with guides, practice sets, and AI-powered mock interviews.',
}

export default function LearnLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
