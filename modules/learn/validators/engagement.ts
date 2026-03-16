import { z } from 'zod'

export const SubmitDailyChallengeSchema = z.object({
  answer: z.string().min(10, 'Answer must be at least 10 characters').max(5000),
})

export const BadgeNotifySchema = z.object({
  badgeId: z.string().min(1).max(50),
})

export const XpHistoryQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
})
