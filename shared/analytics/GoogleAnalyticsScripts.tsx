'use client'

import Script from 'next/script'

/**
 * Drop-in replacement for `@next/third-parties/google`'s `<GoogleAnalytics>`,
 * with one critical difference: the init snippet calls
 * `gtag('config', GA_ID, { send_page_view: false })`.
 *
 * Why: with the default `gtag('config', GA_ID)` (what the third-parties
 * helper ships), gtag.js fires an automatic `page_view` on initial load
 * AND attaches a History API listener that fires another on every
 * client-side route change — including admin surfaces (`/cms`, `/hire`).
 * Our `track()` denylist only filters custom events; it can't suppress
 * the auto-pageviews. Disabling them at init is the only mechanism that
 * actually keeps admin traffic out of the GA property.
 *
 * Pageview tracking can be re-introduced in Phase 2 by emitting
 * `track('page_view', { ... })` from a client-side route-change hook
 * that respects the same admin denylist as `dispatchToGa`.
 */
export function GoogleAnalyticsScripts({ gaId }: { gaId: string }) {
  return (
    <>
      <Script
        id="_ga-loader"
        src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
        strategy="afterInteractive"
      />
      <Script
        id="_ga-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){window.dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${gaId}', { send_page_view: false });
          `,
        }}
      />
    </>
  )
}
