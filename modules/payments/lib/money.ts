import { z } from 'zod'

declare const INR_PAISE_BRAND: unique symbol

/** An INR amount represented only as non-negative integer paise. */
export type InrPaise = number & {
  readonly [INR_PAISE_BRAND]: 'InrPaise'
}

const SafeNonNegativeIntegerSchema = z.number()
  .refine(Number.isSafeInteger, 'Amount must be a safe integer')
  .refine((value) => value >= 0, 'Amount cannot be negative')

/** Boundary schema for amounts already denominated in INR paise. */
export const InrPaiseSchema = SafeNonNegativeIntegerSchema
  .transform((value) => (
    Object.is(value, -0) ? 0 : value
  ) as InrPaise)

export function inrPaise(value: unknown): InrPaise {
  return InrPaiseSchema.parse(value)
}

export function isInrPaise(value: unknown): value is InrPaise {
  return InrPaiseSchema.safeParse(value).success
}

function assertInrPaise(value: InrPaise, label: string): void {
  if (!isInrPaise(value)) {
    throw new RangeError(`${label} must be non-negative safe-integer INR paise`)
  }
}

export function addInrPaise(left: InrPaise, right: InrPaise): InrPaise {
  assertInrPaise(left, 'left')
  assertInrPaise(right, 'right')
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError('INR paise addition overflow')
  }
  return inrPaise(left + right)
}

export function subtractInrPaise(
  minuend: InrPaise,
  subtrahend: InrPaise,
): InrPaise {
  assertInrPaise(minuend, 'minuend')
  assertInrPaise(subtrahend, 'subtrahend')
  if (subtrahend > minuend) {
    throw new RangeError('INR paise subtraction cannot produce a negative amount')
  }
  return inrPaise(minuend - subtrahend)
}

/** Multiply money by a dimensionless non-negative safe integer. */
export function multiplyInrPaise(
  amount: InrPaise,
  multiplier: number,
): InrPaise {
  assertInrPaise(amount, 'amount')
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) {
    throw new RangeError('Multiplier must be a non-negative safe integer')
  }
  if (
    amount !== 0 &&
    multiplier > Math.floor(Number.MAX_SAFE_INTEGER / amount)
  ) {
    throw new RangeError('INR paise multiplication overflow')
  }
  return inrPaise(amount * multiplier)
}

export const INDIA_GST_RATE_BPS = 1_800 as const

/**
 * The caller supplies only authoritative price components. payablePaise is
 * deliberately absent: it is always derived as listPricePaise-discountPaise.
 */
export const InrQuoteInputSchema = z.object({
  listPricePaise: InrPaiseSchema,
  discountPaise: InrPaiseSchema,
  renewalPricePaise: InrPaiseSchema,
}).strict()

export const InrQuoteSchema = z.object({
  schemaVersion: z.literal(1),
  currency: z.literal('INR'),
  listPricePaise: InrPaiseSchema,
  discountPaise: InrPaiseSchema,
  payablePaise: InrPaiseSchema,
  renewalPricePaise: InrPaiseSchema,
  gst: z.object({
    inclusive: z.literal(true),
    rateBps: z.literal(INDIA_GST_RATE_BPS),
    componentAllocation: z.literal('unallocated'),
  }).strict(),
}).strict().superRefine((quote, context) => {
  if (quote.discountPaise > quote.listPricePaise) {
    context.addIssue({
      code: 'custom',
      path: ['discountPaise'],
      message: 'Discount cannot exceed list price',
    })
    return
  }

  const expectedPayable = quote.listPricePaise - quote.discountPaise
  if (quote.payablePaise !== expectedPayable) {
    context.addIssue({
      code: 'custom',
      path: ['payablePaise'],
      message: 'Payable must equal list price minus discount',
    })
  }
})

export type InrQuoteInput = z.input<typeof InrQuoteInputSchema>
export type InrQuote = z.output<typeof InrQuoteSchema>

/**
 * Derive an internally consistent, GST-inclusive quote without allocating
 * GST between CGST, SGST, or IGST.
 */
export function deriveInrQuote(input: InrQuoteInput): InrQuote {
  const parsed = InrQuoteInputSchema.parse(input)
  if (parsed.discountPaise > parsed.listPricePaise) {
    throw new RangeError('Discount cannot exceed list price')
  }

  return InrQuoteSchema.parse({
    schemaVersion: 1,
    currency: 'INR',
    listPricePaise: parsed.listPricePaise,
    discountPaise: parsed.discountPaise,
    payablePaise: subtractInrPaise(
      parsed.listPricePaise,
      parsed.discountPaise,
    ),
    renewalPricePaise: parsed.renewalPricePaise,
    gst: {
      inclusive: true,
      rateBps: INDIA_GST_RATE_BPS,
      componentAllocation: 'unallocated',
    },
  })
}

/**
 * Stable versioned payload for a future SHA-256 step. Field order is fixed
 * here rather than inherited from caller object insertion order, and every
 * numeric field is a validated integer (never a rupee float).
 */
export function canonicalInrQuoteHashInput(quote: unknown): string {
  const parsed = InrQuoteSchema.parse(quote)
  return JSON.stringify({
    currency: parsed.currency,
    discountPaise: parsed.discountPaise,
    gstComponentAllocation: parsed.gst.componentAllocation,
    gstInclusive: parsed.gst.inclusive,
    gstRateBps: parsed.gst.rateBps,
    listPricePaise: parsed.listPricePaise,
    payablePaise: parsed.payablePaise,
    quoteSchemaVersion: parsed.schemaVersion,
    renewalPricePaise: parsed.renewalPricePaise,
  })
}
