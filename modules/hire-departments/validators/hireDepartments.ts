import { z } from 'zod'

export const HireDepartmentIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Invalid department id')

const departmentName = z
  .string()
  .trim()
  .min(2, 'Department name is too short')
  .max(120, 'Department name is too long')
  .transform((value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim())

/** Only normal departments can be submitted by an HR member. */
export const CreateHireDepartmentSchema = z
  .object({ name: departmentName })
  .strict()

/** Reused by job-create, job-duplicate, and explicit reassignment routes. */
export const AssignHireDepartmentSchema = z
  .object({ departmentId: HireDepartmentIdSchema })
  .strict()

/** Administrative catalog lifecycle only; system kinds are never client input. */
export const UpdateHireDepartmentSchema = z
  .object({
    action: z.enum(['archive', 'restore']),
  })
  .strict()

export type CreateHireDepartmentPayload = z.infer<typeof CreateHireDepartmentSchema>
export type AssignHireDepartmentPayload = z.infer<typeof AssignHireDepartmentSchema>
export type UpdateHireDepartmentPayload = z.infer<typeof UpdateHireDepartmentSchema>
