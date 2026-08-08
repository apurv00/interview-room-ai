import type { Metadata } from 'next'
import Link from 'next/link'
import { siteConfig } from '@shared/siteConfig'

export const metadata: Metadata = {
  title: 'Contact Us',
  description: `Contact ${siteConfig.name} for account, payment, privacy, or legal questions.`,
  alternates: { canonical: '/contact' },
}

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">Contact Us</h1>
      <p className="text-sm text-[#8b98a5] mb-10">
        Last updated: 7 August 2026
      </p>

      <div className="space-y-8 text-sm text-[#536471] leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Account and payment support
          </h2>
          <p>
            Email{' '}
            <a
              href="mailto:contact@interviewprep.guru"
              className="text-[#2563eb] hover:text-blue-700"
            >
              contact@interviewprep.guru
            </a>
            . For a billing issue, write from your account email and include the
            selected plan, payment date, approximate amount, and a short
            description.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Privacy questions
          </h2>
          <p>
            Email{' '}
            <a
              href="mailto:privacy@interviewprep.guru"
              className="text-[#2563eb] hover:text-blue-700"
            >
              privacy@interviewprep.guru
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Terms and legal questions
          </h2>
          <p>
            Email{' '}
            <a
              href="mailto:contact@interviewprep.guru"
              className="text-[#2563eb] hover:text-blue-700"
            >
              contact@interviewprep.guru
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Security reminder
          </h2>
          <p>
            {siteConfig.name} will never ask you by email for an OTP, UPI PIN,
            CVV, password, or full card or bank-account number.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm text-[#8b98a5]">
        <Link
          href="/"
          className="text-[#2563eb] hover:text-blue-700 transition"
        >
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
