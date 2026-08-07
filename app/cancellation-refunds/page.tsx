import type { Metadata } from 'next'
import Link from 'next/link'
import { siteConfig } from '@shared/siteConfig'

const CONTACT_EMAIL = 'contact@interviewprep.guru'

export const metadata: Metadata = {
  title: 'Cancellation and Refund Policy',
  description:
    'How Interview Prep Guru subscription cancellations and refund requests are handled.',
  alternates: { canonical: '/cancellation-refunds' },
}

export default function CancellationRefundsPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-[#0f1419] mb-8">
        Cancellation and Refund Policy
      </h1>
      <p className="text-sm text-[#8b98a5] mb-10">
        Last updated: 7 August 2026
      </p>

      <div className="space-y-8 text-sm text-[#536471] leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Subscription cancellation
          </h2>
          <p>
            Plus and Pro are monthly recurring subscriptions. You can request
            cancellation from the{' '}
            <Link
              href="/pricing"
              className="text-[#2563eb] hover:text-blue-700"
            >
              Pricing page
            </Link>{' '}
            in your signed-in account. If that control is unavailable, email{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-[#2563eb] hover:text-blue-700"
            >
              {CONTACT_EMAIL}
            </a>{' '}
            from your account email address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            When cancellation takes effect
          </h2>
          <p>
            Cancellation is scheduled for the end of your current paid billing
            period. Your paid access continues until that date, and unused
            allowance does not roll over. The cancellation status may remain
            pending while {siteConfig.name} confirms it with Razorpay. A
            cancellation request does not itself create a refund.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Incomplete or abandoned checkout
          </h2>
          <p>
            Closing or cancelling the Razorpay checkout before a payment is
            captured does not activate Plus or Pro. An incomplete checkout can
            be replaced by a new checkout. If a captured payment is shown as
            pending, do not pay again; contact us so that we can reconcile the
            payment first.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Refund review
          </h2>
          <p className="mb-3">
            Refunds are not automatic and are reviewed manually. We may approve
            a full or partial refund where appropriate, including for:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>A duplicate captured charge.</li>
            <li>
              A captured payment for which the paid entitlement was not
              delivered.
            </li>
            <li>A refund required by applicable law.</li>
            <li>An exceptional goodwill case approved after review.</li>
          </ul>
          <p className="mt-3">
            Cancelling early, not using the service, or leaving allowance unused
            does not automatically qualify for a refund. Any refund is limited
            to the amount actually paid after a coupon discount.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Requesting a refund
          </h2>
          <p>
            Email{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-[#2563eb] hover:text-blue-700"
            >
              {CONTACT_EMAIL}
            </a>{' '}
            from your account email address with the plan, payment date, amount,
            and reason for the request. Never send an OTP, UPI PIN, CVV, or full
            card or bank-account number. If approved, the refund is sent to the
            original payment method. Razorpay and your bank or payment provider
            control the final settlement time.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[#0f1419] mb-3">
            Statutory rights
          </h2>
          <p>
            Nothing in this policy limits any non-waivable right or remedy
            available under applicable law.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-8 border-t border-[#e1e8ed] text-sm">
        <Link
          href="/terms"
          className="text-[#2563eb] hover:text-blue-700 transition"
        >
          Read the Terms of Service
        </Link>
      </div>
    </main>
  )
}
