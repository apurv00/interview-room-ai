import Link from 'next/link'

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">Terms of Service</h1>
      <p className="text-sm text-[#8b98a5] mb-10">Last updated: March 2026</p>

      <div className="space-y-8 text-sm text-[#536471] leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">1. Acceptance of Terms</h2>
          <p className="text-[#536471]">
            By accessing or using Interview Prep Guru (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">2. Description of Service</h2>
          <p className="text-[#536471]">
            Interview Prep Guru is an AI-powered mock interview platform that simulates HR screening calls and provides feedback on your interview performance. The Service includes video-based interview practice, AI-generated questions, and scored feedback.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">3. Eligibility</h2>
          <p className="text-[#536471]">
            You must be at least 18 years old and capable of entering into a binding agreement to use the Service. By creating an account, you represent that you meet these requirements.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">4. Account Responsibilities</h2>
          <p className="text-[#536471]">
            You are responsible for maintaining the security of your account credentials. You agree not to share your account or allow unauthorized access. You are responsible for all activity under your account.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">5. Acceptable Use</h2>
          <p className="text-[#536471] mb-2">You agree not to:</p>
          <ul className="list-disc pl-5 space-y-2 text-[#536471]">
            <li>Use the Service for any unlawful purpose or to violate any laws.</li>
            <li>Attempt to reverse engineer, decompile, or extract the AI models or algorithms.</li>
            <li>Upload malicious content, spam, or content that violates the rights of others.</li>
            <li>Circumvent usage limits, rate limits, or access controls.</li>
            <li>Resell, redistribute, or sublicense access to the Service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">6. Intellectual Property</h2>
          <p className="text-[#536471]">
            The Service, including its design, AI models, and content, is owned by Interview Prep Guru. You retain ownership of any documents you upload (resumes, job descriptions). By uploading content, you grant us a limited license to process it for providing the Service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">7. Subscriptions &amp; Billing</h2>
          <p className="text-[#536471]">
            Free accounts include a limited number of interviews per month. Paid plans are billed monthly and renew automatically. You may cancel at any time; cancellation takes effect at the end of the current billing period. Refunds are not provided for partial months.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">8. Limitation of Liability</h2>
          <p className="text-[#536471]">
            The Service is provided &quot;as is&quot; without warranties of any kind. Interview Prep Guru is not liable for any indirect, incidental, or consequential damages arising from your use of the Service. AI-generated feedback is for practice purposes only and does not guarantee interview success.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">9. Termination</h2>
          <p className="text-[#536471]">
            We reserve the right to suspend or terminate your account if you violate these Terms. You may delete your account at any time from your <Link href="/settings" className="text-[#6366f1] hover:text-indigo-700">account settings</Link>.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">10. Changes to Terms</h2>
          <p className="text-[#536471]">
            We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">11. Contact</h2>
          <p className="text-[#536471]">
            For questions about these Terms, contact us at{' '}
            <a href="mailto:legal@interviewprep.guru" className="text-[#6366f1] hover:text-indigo-700">legal@interviewprep.guru</a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm text-[#8b98a5]">
        <Link href="/" className="text-[#6366f1] hover:text-indigo-700 transition">
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
