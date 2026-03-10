import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Interview Lobby',
  robots: { index: false },
}

export default function LobbyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
