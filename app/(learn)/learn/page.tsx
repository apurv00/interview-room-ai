'use client'

import { useSession } from 'next-auth/react'
import Link from 'next/link'

export default function LearnPage() {
  const { data: session } = useSession()

  return (
    <main className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Learn &amp; Practice</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-8">
        Master your interview skills with guides, practice sets, and AI-powered mock interviews.
      </p>

      <div className="grid gap-6 md:grid-cols-3">
        <Link
          href="/learn/guides"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Guides</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            In-depth articles on common interview questions, frameworks, and strategies.
          </p>
        </Link>

        <Link
          href="/learn/practice"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Practice Sets</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Focused question sets to build competency in specific areas.
          </p>
        </Link>

        <Link
          href="/learn/progress"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Progress</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Track your competency growth and see personalized improvement pathways.
          </p>
        </Link>

        <Link
          href="/learn/pathway"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-emerald-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Learning Pathway</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your personalized roadmap to interview readiness with milestones and tasks.
          </p>
        </Link>

        <Link
          href="/practice/drill"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-amber-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Drill Mode</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Re-attempt your weakest answers and track improvement over time.
          </p>
        </Link>

        <Link
          href="/dashboard"
          className="block p-6 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-purple-500 transition-colors"
        >
          <h2 className="text-xl font-semibold mb-2">Analytics</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Visualize your score trends, competency radar, and session streaks.
          </p>
        </Link>
      </div>
    </main>
  )
}
