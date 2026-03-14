import { z } from 'zod'

export const ResumeSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  template: z.string().max(50).optional(),
  atsScore: z.number().min(0).max(100).nullable().optional(),
  sections: z.record(z.string(), z.string()).optional(),
  fullText: z.string().max(100000).optional(),
})

export const GenerateSchema = z.object({
  action: z.enum(['enhance', 'generate_full']),
  sectionType: z.string().max(50).optional(),
  currentContent: z.string().max(10000).optional(),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  currentSections: z.array(z.object({
    type: z.string(),
    content: z.string(),
  })).optional(),
})

export const ATSCheckSchema = z.object({
  resumeText: z.string().min(50).max(50000),
  jobDescription: z.string().max(50000).optional(),
})

export const TailorSchema = z.object({
  resumeText: z.string().min(50).max(50000),
  jobDescription: z.string().min(50).max(50000),
  companyName: z.string().max(200).optional(),
})
