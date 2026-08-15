import { z } from 'zod'

export const StartHireOnboardingTestDriveSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict()

export type StartHireOnboardingTestDrivePayload = z.infer<
  typeof StartHireOnboardingTestDriveSchema
>
