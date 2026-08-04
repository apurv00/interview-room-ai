const BASIC_TIME_ZONE = 'Asia/Kolkata'

export interface EntitlementPeriod {
  key: string
  start: Date
  end: Date
}

function zonedYearMonth(date: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BASIC_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  return { year, month }
}

/**
 * Basic periods are calendar months in the product's launch timezone. IST is
 * UTC+05:30 year-round, so boundaries can be represented exactly in UTC.
 */
export function basicCalendarMonthPeriod(now = new Date()): EntitlementPeriod {
  const { year, month } = zonedYearMonth(now)
  const offsetMs = 5.5 * 60 * 60 * 1000
  const start = new Date(Date.UTC(year, month - 1, 1) - offsetMs)
  const end = new Date(Date.UTC(year, month, 1) - offsetMs)
  return {
    key: `basic:${year}-${String(month).padStart(2, '0')}`,
    start,
    end,
  }
}

/**
 * Paid period boundaries come from Razorpay. No caller may synthesize them by
 * adding 30 days.
 */
export function paidBillingPeriod(input: {
  razorpaySubscriptionId: string
  currentStart: Date
  currentEnd: Date
}): EntitlementPeriod {
  if (
    !input.razorpaySubscriptionId ||
    !Number.isFinite(input.currentStart.getTime()) ||
    !Number.isFinite(input.currentEnd.getTime()) ||
    input.currentEnd <= input.currentStart
  ) {
    throw new Error('Valid Razorpay billing boundaries are required')
  }
  return {
    key: `paid:${input.razorpaySubscriptionId}:${Math.floor(
      input.currentStart.getTime() / 1000,
    )}:${Math.floor(input.currentEnd.getTime() / 1000)}`,
    start: input.currentStart,
    end: input.currentEnd,
  }
}
