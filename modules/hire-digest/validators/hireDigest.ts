import { z } from 'zod'

export const UpdateHireDigestPreferenceSchema = z
  .object({ enabled: z.boolean() })
  .strict()

export type UpdateHireDigestPreferenceInput = z.infer<typeof UpdateHireDigestPreferenceSchema>
