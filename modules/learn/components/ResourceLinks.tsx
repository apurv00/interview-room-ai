'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import {
  RESOURCES,
  getResourcesByCategory,
  getPersonalizedResources,
  calculateRelevance,
  type UserProfile,
  type Resource,
} from '@learn/lib/resources'

const COLUMNS = [
  { key: 'questions' as const, label: 'Interview Questions' },
  { key: 'tips' as const, label: 'Tips & Frameworks' },
] as const

export default function ResourceLinks() {
  const { status } = useSession()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [recommended, setRecommended] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((data) => {
        const p: UserProfile = {
          targetRole: data.targetRole,
          experienceLevel: data.experienceLevel,
          interviewGoal: data.interviewGoal,
          weakAreas: data.weakAreas,
          isCareerSwitcher: data.isCareerSwitcher,
        }
        setProfile(p)
        // Mark resources with score > 0 as recommended
        const recs = new Set<string>()
        RESOURCES.forEach((r) => {
          if (calculateRelevance(r, p) > 0) recs.add(r.slug)
        })
        setRecommended(recs)
      })
      .catch(() => {})
  }, [status])

  // Merge questions + frameworks into "questions" column, tips stays as "tips"
  const questionResources = [
    ...getResourcesByCategory('questions'),
    ...getResourcesByCategory('frameworks'),
  ]
  const tipResources = getResourcesByCategory('tips')

  function sortByRelevance(items: Resource[]): Resource[] {
    if (!profile) return items
    return [...items].sort((a, b) => calculateRelevance(b, profile) - calculateRelevance(a, profile))
  }

  return (
    <section className="px-4 sm:px-6 py-section">
      <div className="max-w-[1100px] mx-auto">
        <div className="text-center mb-section">
          <h2 className="text-heading text-[var(--foreground)]">Prepare Before You Practice</h2>
          <p className="text-body text-[var(--foreground-tertiary)] mt-2">
            Free guides, frameworks, and question banks to sharpen your interview skills.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-section">
          {/* Questions Column */}
          <div>
            <h3 className="step-label mb-3">Interview Questions</h3>
            <ul className="space-y-0.5">
              {sortByRelevance(questionResources).map((r) => (
                <ResourceItem key={r.slug} resource={r} isRecommended={recommended.has(r.slug)} />
              ))}
            </ul>
          </div>

          {/* Tips Column */}
          <div>
            <h3 className="step-label mb-3">Tips & Frameworks</h3>
            <ul className="space-y-0.5">
              {sortByRelevance(tipResources).map((r) => (
                <ResourceItem key={r.slug} resource={r} isRecommended={recommended.has(r.slug)} />
              ))}
            </ul>
          </div>
        </div>

        <div className="text-center mt-6">
          <Link
            href="/resources"
            className="text-caption text-[#818cf8] hover:text-[#6366f1] transition-colors"
          >
            Browse all resources &rarr;
          </Link>
        </div>
      </div>
    </section>
  )
}

function ResourceItem({ resource, isRecommended }: { resource: Resource; isRecommended: boolean }) {
  return (
    <li>
      <Link
        href={`/resources/${resource.slug}`}
        className="flex items-center gap-2 py-2 px-3 rounded-[8px] hover:bg-[var(--color-surface)] transition-colors group"
      >
        <span className="text-[#818cf8] flex-shrink-0">›</span>
        <span className="text-body text-[var(--foreground-secondary)] group-hover:text-[var(--foreground)] transition-colors">
          {resource.title}
        </span>
        {isRecommended && (
          <span className="ml-auto text-micro text-[#818cf8] bg-[rgba(99,102,241,0.08)] px-1.5 py-0.5 rounded flex-shrink-0">
            For you
          </span>
        )}
      </Link>
    </li>
  )
}
