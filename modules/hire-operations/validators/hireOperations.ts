import { z } from "zod";

const operationsObjectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, "Invalid id");

/** Path-only contract for `GET /api/workspace/jobs/:jobId/performance`. */
export const HireOperationsJobParamsSchema = z
  .object({ jobId: operationsObjectIdSchema })
  .strict();

export type HireOperationsJobParams = z.infer<
  typeof HireOperationsJobParamsSchema
>;

/** Query contract for `GET /api/workspace/audit`. */
export const HireOperationsAuditQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type HireOperationsAuditQuery = z.infer<
  typeof HireOperationsAuditQuerySchema
>;
