import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Practice Sets | Interview Prep Guru',
  description: 'Personalized practice sets tailored to your profile, target role, and interview goals.',
}

export default function PracticeLayout({ children }: { children: React.ReactNode }) {
  return children
}
