import { z } from 'zod'

/**
 * Active Indian State/UT GST codes accepted for consumer place of supply.
 * Retired codes 25 and 28 and non-customer jurisdictions 97/99 are excluded.
 */
export const INDIA_BILLING_STATE_CODES = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '26',
  '27',
  '29',
  '30',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
] as const

export const CustomerPlaceOfSupplyInputSchema = z
  .object({
    stateCode: z.string().trim().pipe(z.enum(INDIA_BILLING_STATE_CODES)),
    countryCode: z.literal('IN'),
  })
  .strict()

export const CustomerBillingProfileMutationIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const CustomerBillingProfileUpsertSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().safe(),
    mutationId: CustomerBillingProfileMutationIdSchema,
    placeOfSupply: CustomerPlaceOfSupplyInputSchema,
  })
  .strict()

export type CustomerBillingProfileUpsertInput = z.output<
  typeof CustomerBillingProfileUpsertSchema
>
