'use client'

export interface RazorpaySuccessPayload {
  razorpay_payment_id: string
  razorpay_signature: string
  razorpay_order_id?: string
  razorpay_subscription_id?: string
}

interface RazorpayFailurePayload {
  error?: {
    code?: string
    description?: string
    source?: string
    step?: string
    reason?: string
  }
}

interface RazorpayCheckoutBaseOptions {
  key: string
  name: string
  description: string
  handler: (payload: RazorpaySuccessPayload) => void | Promise<void>
  modal: {
    ondismiss: () => void
    escape: boolean
    confirm_close: boolean
  }
  theme: {
    color: string
  }
  retry: {
    enabled: boolean
  }
}

export type RazorpayCheckoutOptions = RazorpayCheckoutBaseOptions & (
  | {
      subscription_id: string
      order_id?: never
    }
  | {
      order_id: string
      subscription_id?: never
    }
)

export interface RazorpayCheckoutInstance {
  open(): void
  on(
    event: 'payment.failed',
    handler: (payload: RazorpayFailurePayload) => void,
  ): void
}

interface RazorpayConstructor {
  new(options: RazorpayCheckoutOptions): RazorpayCheckoutInstance
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor
  }
}

const RAZORPAY_CHECKOUT_SRC =
  'https://checkout.razorpay.com/v1/checkout.js'
let checkoutLoader: Promise<RazorpayConstructor> | null = null

export function loadRazorpayCheckout(): Promise<RazorpayConstructor> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay Checkout requires a browser'))
  }
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  if (checkoutLoader) return checkoutLoader

  checkoutLoader = new Promise<RazorpayConstructor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SRC}"]`,
    )
    const script = existing ?? document.createElement('script')

    const cleanup = () => {
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
    }
    const handleLoad = () => {
      cleanup()
      if (window.Razorpay) {
        resolve(window.Razorpay)
        return
      }
      checkoutLoader = null
      reject(new Error('Razorpay Checkout did not initialize'))
    }
    const handleError = () => {
      cleanup()
      checkoutLoader = null
      if (script.dataset.billingCheckout === 'razorpay') {
        script.remove()
      }
      reject(new Error('Razorpay Checkout could not be loaded'))
    }

    script.addEventListener('load', handleLoad)
    script.addEventListener('error', handleError)
    if (!existing) {
      script.src = RAZORPAY_CHECKOUT_SRC
      script.async = true
      script.dataset.billingCheckout = 'razorpay'
      document.head.appendChild(script)
    }
  })

  return checkoutLoader
}
