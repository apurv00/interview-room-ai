import { z } from 'zod'

export const HIRE_MEMBER_DELETION_BRIDGE_SCHEMA_VERSION = 1 as const

export const HireMemberDeletionBridgeRequestSchema = z
  .object({
    schemaVersion: z.literal(HIRE_MEMBER_DELETION_BRIDGE_SCHEMA_VERSION),
    phase: z.enum(['preflight', 'commit']),
    b2cUserId: z.string().regex(/^[a-f0-9]{24}$/i),
    operationId: z.string().uuid(),
    workspaceConfirmationName: z.string().min(1).max(120).optional(),
    acknowledgeWorkspaceDeletion: z.boolean().optional(),
  })
  .strict()

export const HireMemberDeletionBridgeSuccessSchema = z
  .object({
    ok: z.literal(true),
    action: z.enum([
      'not_linked',
      'member_removal_required',
      'workspace_deletion_required',
      'member_removed',
      'workspace_deletion_scheduled',
    ]),
    purgeAfter: z.string().datetime().optional(),
  })
  .strict()

export const HireMemberDeletionBridgeBlockedSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum([
      'HIRE_ADMIN_TRANSFER_REQUIRED',
      'HIRE_WORKSPACE_DELETE_CONFIRMATION_REQUIRED',
    ]),
    error: z.string().min(1).max(500),
    workspaceName: z.string().min(1).max(120).optional(),
  })
  .strict()

export type HireMemberDeletionBridgeRequest = z.infer<
  typeof HireMemberDeletionBridgeRequestSchema
>
export type HireMemberDeletionBridgeSuccess = z.infer<
  typeof HireMemberDeletionBridgeSuccessSchema
>
export type HireMemberDeletionBridgeBlocked = z.infer<
  typeof HireMemberDeletionBridgeBlockedSchema
>
