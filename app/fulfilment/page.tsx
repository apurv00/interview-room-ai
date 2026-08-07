import type { Metadata } from 'next'
import Link from 'next/link'
import { siteConfig } from '@shared/siteConfig'

const CONTACT_EMAIL = 'contact@interviewprep.guru'

export const metadata: Metadata = {
  title: 'Fulfilment Policy',
  description:
    'How Interview Prep Guru delivers paid digital subscription access after payment.',
  alternates: { canonical: '/fulfilment' },
}

export default function FulfilmentPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">
        Fulfilment Policy
      </h1>
      <p className="text-sm text-[#8b98a5] mb-10">
        Last updated: 7 August 2026
      </p>

      <div className="space-y-8 text-sm text-[#536471] leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Digital service only
          </h2>
          <p>
            {siteConfig.name} provides online interview-preparation services.
            Plus and Pro are digital subscriptions; no physical product is
            shipped and no shipping charge applies.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            How access is delivered
          </h2>
          <p>
            Paid access is assigned to the same signed-in account used at
            checkout. Fulfilment begins only after Razorpay reports a captured
            payment and our server confirms the payment against the selected
            plan. A browser callback, mandate authorisation, or
            authorised-but-uncaptured payment is not enough to activate paid
            access.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Pending confirmation
          </h2>
          <p>
            Bank, UPI, mandate, webhook, or network delays can leave a captured
            payment temporarily pending while it is reconciled. Do not make a
            second payment for the same purchase. Refresh the Pricing page
            first; if access still does not appear, contact us from your account
            email address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Subscription period and coupons
          </h2>
          <p>
            Plus and Pro access is provided for each successfully paid monthly
            billing period. An Interview Prep Guru coupon changes only the
            amount and billing cycles stated in the server-confirmed checkout.
            It does not change the fulfilment method or create access before
            payment capture.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Fulfilment support
          </h2>
          <p>
            For a captured payment that has not produced paid access, email{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-[#2563eb] hover:text-blue-700"
            >
              {CONTACT_EMAIL}
            </a>{' '}
            with your account email, selected plan, payment date, and amount.
            Never send an OTP, UPI PIN, CVV, or full card or bank-account
            number. Refunds are handled under our{' '}
            <Link
              href="/cancellation-refunds"
              className="text-[#2563eb] hover:text-blue-700"
            >
              Cancellation and Refund Policy
            </Link>
            .
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm">
        <Link
          href="/pricing"
          className="text-[#2563eb] hover:text-blue-700 transition"
        >
          View pricing
        </Link>
      </div>
    </main>
  )
}
