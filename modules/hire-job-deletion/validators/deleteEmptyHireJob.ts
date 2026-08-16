import { z } from "zod";

/**
 * A destructive command must be deliberate. The service compares the
 * normalized confirmation value to the authoritative job title inside its
 * transaction; this schema only accepts the bounded transport shape.
 */
export const DeleteEmptyHireJobSchema = z
  .object({
    confirmationTitle: z.string().trim().min(1).max(200),
    acknowledgeEmptyJobDeletion: z.literal(true),
  })
  .strict();

export type DeleteEmptyHireJobPayload = z.infer<
  typeof DeleteEmptyHireJobSchema
>;
