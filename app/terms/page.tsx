import Link from 'next/link'

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">Terms of Service</h1>
      <p className="text-sm text-[#8b98a5] mb-10">Last updated: 7 August 2026</p>

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
          <div className="space-y-3 text-[#536471]">
            <p>
              Basic is a limited ₹0 plan. Plus costs ₹599 per month and Pro costs ₹999 per month. Paid-plan prices include GST and are charged through Razorpay. Plus and Pro renew automatically each month until cancelled.
            </p>
            <p>
              Interview Prep Guru may issue its own coupon codes. Coupon eligibility, the discounted amount, and the number of discounted billing cycles are shown in our checkout before payment. Unless the checkout says otherwise, a subscription renews at its undiscounted list price after the coupon period. These coupons are administered by Interview Prep Guru and do not depend on a Razorpay promotional offer.
            </p>
            <p>
              Paid access is activated only after the payment is captured and confirmed by our server. Opening or authorising a Razorpay checkout, or returning to our website without a captured payment, does not activate a paid plan.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">8. Cancellation &amp; Refunds</h2>
          <p className="text-[#536471]">
            A subscription cancellation takes effect at the end of the current paid billing period, so access continues until that date. Cancellation does not automatically create a refund. Refund requests are reviewed manually under our{' '}
            <Link href="/cancellation-refunds" className="text-[#2563eb] hover:text-blue-700">Cancellation and Refund Policy</Link>.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">9. Limitation of Liability</h2>
          <p className="text-[#536471]">
            The Service is provided &quot;as is&quot; without warranties of any kind. Interview Prep Guru is not liable for any indirect, incidental, or consequential damages arising from your use of the Service. AI-generated feedback is for practice purposes only and does not guarantee interview success.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">10. Termination</h2>
          <p className="text-[#536471]">
            We reserve the right to suspend or terminate your account if you violate these Terms. You may delete your account at any time from your <Link href="/settings" className="text-[#2563eb] hover:text-blue-700">account settings</Link>.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">11. Changes to Terms</h2>
          <p className="text-[#536471]">
            We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">12. Contact</h2>
          <p className="text-[#536471]">
            For questions about these Terms, contact us at{' '}
            <a href="mailto:contact@interviewprep.guru" className="text-[#2563eb] hover:text-blue-700">contact@interviewprep.guru</a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm text-[#8b98a5]">
        <Link href="/" className="text-[#2563eb] hover:text-blue-700 transition">
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
