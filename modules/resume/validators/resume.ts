import { z } from 'zod'

// ─── Clamping helpers ────────────────────────────────────────────────────────
// Size caps CLAMP instead of reject: a hard .max() on user/AI-shaped content
// made whole resumes permanently unsavable (one AI-enhanced 1001-char bullet →
// bare "Invalid data" with no field info). Truncating to the cap loses at most
// the overflow; rejecting lost the entire save. Structural rules (required
// fields, enums, numeric ranges) still validate normally.

const clampStr = (max: number) => z.string().transform((s) => s.slice(0, max))
const clampArr = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).transform((a) => a.slice(0, max))

// ─── Structured Resume Sub-schemas ─────────────────────────────────────────

export const ContactInfoSchema = z.object({
  fullName: clampStr(200).default(''),
  email: clampStr(200).default(''),
  phone: clampStr(30).optional(),
  location: clampStr(200).optional(),
  linkedin: clampStr(500).optional(),
  website: clampStr(500).optional(),
  github: clampStr(500).optional(),
})

export const ExperienceSchema = z.object({
  id: z.string(),
  company: clampStr(200),
  title: clampStr(200),
  location: clampStr(200).optional(),
  startDate: clampStr(50),
  endDate: clampStr(50).optional(),
  bullets: clampArr(clampStr(1000), 20),
})

export const EducationSchema = z.object({
  id: z.string(),
  institution: clampStr(200),
  degree: clampStr(200),
  field: clampStr(200).optional(),
  graduationDate: clampStr(50).optional(),
  gpa: clampStr(10).optional(),
  honors: clampStr(200).optional(),
})

export const SkillCategorySchema = z.object({
  category: clampStr(100),
  items: clampArr(clampStr(100), 50),
})

export const ProjectSchema = z.object({
  id: z.string(),
  name: clampStr(200),
  description: clampStr(2000),
  technologies: clampArr(clampStr(100), 20).optional(),
  url: clampStr(500).optional(),
})

export const CertificationSchema = z.object({
  name: clampStr(200),
  issuer: clampStr(200),
  date: clampStr(50).optional(),
})

export const CustomSectionSchema = z.object({
  id: z.string(),
  title: clampStr(200),
  content: clampStr(5000),
})

// ─── Styling Schema ─────────────────────────────────────────────────────────

export const ResumeStylingSchema = z.object({
  fontFamily: z.enum(['georgia', 'times', 'garamond', 'palatino', 'calibri', 'helvetica', 'lato', 'roboto']).optional(),
  fontSize: z.enum(['small', 'medium', 'large']).optional(),
  headingSize: z.number().min(12).max(28).optional(),
  bodySize: z.number().min(7).max(14).optional(),
})

// ─── Full Resume Schema (for save) ─────────────────────────────────────────

export const ResumeSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).transform((s) => s.slice(0, 200)),
  template: clampStr(50).optional(),
  targetRole: clampStr(200).optional(),
  targetCompany: clampStr(200).optional(),
  atsScore: z.number().min(0).max(100).nullable().optional(),

  contactInfo: ContactInfoSchema.optional(),
  summary: clampStr(5000).optional(),
  experience: clampArr(ExperienceSchema, 20).optional(),
  education: clampArr(EducationSchema, 10).optional(),
  skills: clampArr(SkillCategorySchema, 20).optional(),
  projects: clampArr(ProjectSchema, 20).optional(),
  certifications: clampArr(CertificationSchema, 20).optional(),
  customSections: clampArr(CustomSectionSchema, 10).optional(),
  sectionOrder: clampArr(clampStr(100), 20).optional(),
  styling: ResumeStylingSchema.optional(),

  // Legacy support
  sections: z.record(z.string(), z.string()).optional(),
  fullText: clampStr(100_000).optional(),
})

// ─── AI Generation Schemas ──────────────────────────────────────────────────

export const GenerateSchema = z.object({
  action: z.enum(['enhance', 'generate_full', 'enhance_bullets']),
  sectionType: z.string().max(50).optional(),
  currentContent: z.string().max(10000).optional(),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  currentSections: z.array(z.object({
    type: z.string(),
    content: z.string(),
  })).optional(),
  // For enhance_bullets
  bullets: z.array(z.string().max(1000)).max(20).optional(),
  context: z.object({
    role: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
    targetRole: z.string().max(200).optional(),
  }).optional(),
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

export const ParseResumeSchema = z.object({
  text: z.string().min(10).max(50000),
})

export const PDFGenerateSchema = z.object({
  resumeData: ResumeSchema,
  templateId: z.string().max(50),
})

// ─── Type exports ───────────────────────────────────────────────────────────

export type ResumeContactInfo = z.infer<typeof ContactInfoSchema>
export type ResumeExperience = z.infer<typeof ExperienceSchema>
export type ResumeEducation = z.infer<typeof EducationSchema>
export type ResumeSkillCategory = z.infer<typeof SkillCategorySchema>
export type ResumeProject = z.infer<typeof ProjectSchema>
export type ResumeCertification = z.infer<typeof CertificationSchema>
export type ResumeCustomSection = z.infer<typeof CustomSectionSchema>
export type ResumeStyling = z.infer<typeof ResumeStylingSchema>
export type ResumeData = z.infer<typeof ResumeSchema>
