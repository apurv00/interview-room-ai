import { z } from 'zod'

// ─── Structured Resume Sub-schemas ─────────────────────────────────────────

export const ContactInfoSchema = z.object({
  fullName: z.string().max(200).default(''),
  email: z.string().max(200).default(''),
  phone: z.string().max(30).optional(),
  location: z.string().max(200).optional(),
  linkedin: z.string().max(500).optional(),
  website: z.string().max(500).optional(),
  github: z.string().max(500).optional(),
})

export const ExperienceSchema = z.object({
  id: z.string(),
  company: z.string().max(200),
  title: z.string().max(200),
  location: z.string().max(200).optional(),
  startDate: z.string().max(50),
  endDate: z.string().max(50).optional(),
  bullets: z.array(z.string().max(1000)).max(20),
})

export const EducationSchema = z.object({
  id: z.string(),
  institution: z.string().max(200),
  degree: z.string().max(200),
  field: z.string().max(200).optional(),
  graduationDate: z.string().max(50).optional(),
  gpa: z.string().max(10).optional(),
  honors: z.string().max(200).optional(),
})

export const SkillCategorySchema = z.object({
  category: z.string().max(100),
  items: z.array(z.string().max(100)).max(50),
})

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().max(200),
  description: z.string().max(2000),
  technologies: z.array(z.string().max(100)).max(20).optional(),
  url: z.string().max(500).optional(),
})

export const CertificationSchema = z.object({
  name: z.string().max(200),
  issuer: z.string().max(200),
  date: z.string().max(50).optional(),
})

export const CustomSectionSchema = z.object({
  id: z.string(),
  title: z.string().max(200),
  content: z.string().max(5000),
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
  name: z.string().min(1).max(200),
  template: z.string().max(50).optional(),
  targetRole: z.string().max(200).optional(),
  targetCompany: z.string().max(200).optional(),
  atsScore: z.number().min(0).max(100).nullable().optional(),

  contactInfo: ContactInfoSchema.optional(),
  summary: z.string().max(5000).optional(),
  experience: z.array(ExperienceSchema).max(20).optional(),
  education: z.array(EducationSchema).max(10).optional(),
  skills: z.array(SkillCategorySchema).max(20).optional(),
  projects: z.array(ProjectSchema).max(20).optional(),
  certifications: z.array(CertificationSchema).max(20).optional(),
  customSections: z.array(CustomSectionSchema).max(10).optional(),
  sectionOrder: z.array(z.string()).max(20).optional(),
  styling: ResumeStylingSchema.optional(),

  // Legacy support
  sections: z.record(z.string(), z.string()).optional(),
  fullText: z.string().max(100000).optional(),
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
  previewHtml: z.string().max(2_000_000).optional(),
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
