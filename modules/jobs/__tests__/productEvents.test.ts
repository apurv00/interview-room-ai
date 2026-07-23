import { describe, expect, it } from 'vitest'
import {
  BROWSER_PRODUCT_EVENT_NAMES,
  PRODUCT_EVENT_NAMES,
  ProductEventInputSchema,
} from '../validators/productEvents'

describe('ProductEventInputSchema browser trust boundary', () => {
  it.each(BROWSER_PRODUCT_EVENT_NAMES)('accepts browser-owned event %s', (name) => {
    expect(ProductEventInputSchema.safeParse({ name, props: {} }).success).toBe(true)
  })

  const protectedNames = PRODUCT_EVENT_NAMES.filter(
    (name) => !BROWSER_PRODUCT_EVENT_NAMES.includes(
      name as (typeof BROWSER_PRODUCT_EVENT_NAMES)[number],
    ),
  )

  it.each(protectedNames)('rejects server/worker-owned event %s', (name) => {
    expect(ProductEventInputSchema.safeParse({ name, props: {} }).success).toBe(false)
  })

  it.each(['applicationId', 'sessionId', 'userId', 'anonId', 'producer'])(
    'rejects browser-supplied authoritative field %s',
    (field) => {
      expect(ProductEventInputSchema.safeParse({
        name: 'jobs.job_viewed',
        jobPostingId: '507f1f77bcf86cd799439011',
        [field]: '507f1f77bcf86cd799439010',
      }).success).toBe(false)
    },
  )
})
