import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('customer billing middleware allowlist', () => {
  it('keeps launch policy pages public through exact paths', () => {
    const source = readFileSync(
      join(process.cwd(), 'middleware.ts'),
      'utf8',
    )

    for (const publicPath of [
      '/cancellation-refunds',
      '/fulfilment',
      '/contact',
    ]) {
      expect(source.match(
        new RegExp(`pathname === '${publicPath}'`, 'g'),
      )).toHaveLength(1)
      expect(source).not.toContain(
        `pathname.startsWith('${publicPath}')`,
      )
    }
  })

  it('uses exact public and handler-gated billing passthrough paths', () => {
    const source = readFileSync(
      join(process.cwd(), 'middleware.ts'),
      'utf8',
    )

    expect(source.match(
      /pathname === '\/api\/billing\/catalog'/g,
    )).toHaveLength(1)
    expect(source.match(
      /pathname === '\/api\/billing\/webhooks\/razorpay'/g,
    )).toHaveLength(1)
    expect(source.match(
      /pathname === '\/api\/billing\/analytics\/checkout-observation'/g,
    )).toHaveLength(1)

    expect(source).not.toContain("pathname.startsWith('/api/billing')")
    expect(source).not.toContain(
      "pathname.startsWith('/api/billing/catalog')",
    )
    expect(source).not.toContain(
      "pathname.startsWith('/api/billing/webhooks')",
    )

    for (const protectedPath of [
      '/api/billing/me',
      '/api/billing/profile',
      '/api/billing/invoices',
      '/api/billing/quote',
      '/api/billing/subscriptions/checkout',
    ]) {
      expect(source, protectedPath).not.toContain(
        `pathname === '${protectedPath}'`,
      )
    }
  })
})
