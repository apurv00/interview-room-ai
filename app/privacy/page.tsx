import Link from 'next/link'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-white mb-8">Privacy Policy</h1>
      <p className="text-sm text-slate-500 mb-10">Last updated: March 2026</p>

      <div className="space-y-8 text-sm text-slate-300 leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">1. Information We Collect</h2>
          <ul className="list-disc pl-5 space-y-2 text-slate-400">
            <li><strong className="text-slate-300">Account information:</strong> Name, email address, and profile photo when you sign in with Google, GitHub, or email.</li>
            <li><strong className="text-slate-300">Interview data:</strong> Audio/video recordings, transcripts, and feedback generated during mock interview sessions.</li>
            <li><strong className="text-slate-300">Uploaded documents:</strong> Job descriptions and resumes you upload to personalize your sessions.</li>
            <li><strong className="text-slate-300">Usage data:</strong> Pages visited, session counts, and feature usage to improve the service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">2. How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-2 text-slate-400">
            <li>To provide AI-powered interview practice and generate personalized feedback.</li>
            <li>To track your progress and interview history across sessions.</li>
            <li>To improve our AI models and interview question quality.</li>
            <li>To communicate service updates and respond to support requests.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">3. Third-Party Services</h2>
          <p className="text-slate-400">
            We use the following third-party services to operate Interview Prep Guru:
          </p>
          <ul className="list-disc pl-5 space-y-2 text-slate-400 mt-2">
            <li><strong className="text-slate-300">Authentication providers:</strong> Google and GitHub OAuth for sign-in.</li>
            <li><strong className="text-slate-300">AI processing:</strong> OpenAI and Anthropic APIs to generate interview questions and feedback. Your interview data is sent to these services for processing.</li>
            <li><strong className="text-slate-300">Payment processing:</strong> Stripe for subscription billing (Pro plan).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">4. Data Retention</h2>
          <p className="text-slate-400">
            Interview recordings and transcripts are stored as long as your account is active. You can delete individual interview records from your <Link href="/history" className="text-indigo-400 hover:text-indigo-300">history page</Link>. If you delete your account, all associated data will be permanently removed within 30 days.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">5. Data Security</h2>
          <p className="text-slate-400">
            We use industry-standard encryption (TLS) for data in transit and encrypt sensitive data at rest. Access to user data is restricted to authorized personnel only.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">6. Your Rights</h2>
          <p className="text-slate-400">
            You have the right to access, correct, or delete your personal data at any time. You can manage your data from your <Link href="/settings" className="text-indigo-400 hover:text-indigo-300">account settings</Link> or by contacting us directly.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-3">7. Contact</h2>
          <p className="text-slate-400">
            For privacy-related questions, contact us at{' '}
            <a href="mailto:privacy@interviewroom.ai" className="text-indigo-400 hover:text-indigo-300">privacy@interviewroom.ai</a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-slate-800 text-sm text-slate-500">
        <Link href="/" className="text-indigo-400 hover:text-indigo-300 transition">
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
