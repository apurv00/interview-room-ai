import { z } from 'zod'

/** Logo bytes are decoded and magic-byte validated by the branding service. */
export const UploadHireWorkspaceLogoSchema = z
  .object({
    // Base64 overhead makes the transport cap slightly larger than the
    // 512 KiB object cap; the service is the final authoritative guard.
    dataUrl: z.string().min(1).max(720_000),
  })
  .strict()

export type UploadHireWorkspaceLogoPayload = z.infer<typeof UploadHireWorkspaceLogoSchema>
