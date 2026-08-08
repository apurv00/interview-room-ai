import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  document.querySelectorAll(
    'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
  ).forEach((script) => script.remove())
  delete window.Razorpay
  vi.useRealTimers()
  vi.resetModules()
})

describe('loadRazorpayCheckout', () => {
  it('times out a stalled script, resets the loader, and permits a retry', async () => {
    vi.useFakeTimers()
    const {
      loadRazorpayCheckout,
      RAZORPAY_SCRIPT_TIMEOUT_MS,
    } = await import('../razorpayBrowser')

    const firstLoad = loadRazorpayCheckout()
    const firstRejection = expect(firstLoad).rejects.toThrow(
      'Razorpay Checkout loading timed out',
    )
    await vi.advanceTimersByTimeAsync(RAZORPAY_SCRIPT_TIMEOUT_MS)
    await firstRejection
    expect(document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    )).toBeNull()

    const retry = loadRazorpayCheckout()
    const retryScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    )
    expect(retryScript).not.toBeNull()
    window.Razorpay = class {
      open() {}
      on() {}
    }
    retryScript?.dispatchEvent(new Event('load'))

    await expect(retry).resolves.toBe(window.Razorpay)
  })
})
