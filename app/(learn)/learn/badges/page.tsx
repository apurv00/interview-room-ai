'use client'

import BadgeGallery from '@learn/components/BadgeGallery'

export default function BadgesPage() {
  return (
    <main className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-[#0f1419]">Achievement Badges</h1>
      <p className="text-sm text-[#71767b]">
        Earn badges by practicing interviews, building streaks, hitting score milestones, and exploring different domains.
      </p>
      <BadgeGallery />
    </main>
  )
}
