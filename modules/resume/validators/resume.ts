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
  // Provenance for atsScore: true only when it came from a real ATS check.
  // Round-trips through the editor so a normal save preserves it.
  atsScoreFromCheck: z.boolean().optional(),

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
  // Capped like every sibling field: unbounded here let a generate_full request
  // build a multi-megabyte prompt (thousands of sections × unbounded content),
  // which the per-minute rate limit alone can't bound — each allowed request
  // still bills maximal input tokens. generateFullResume slices content to 500,
  // so 2000 is generous headroom.
  currentSections: z.array(z.object({
    type: z.string().max(50),
    content: z.string().max(2000),
  })).max(20).optional(),
  // For enhance_bullets
  bullets: z.array(z.string().max(1000)).max(20).optional(),
  context: z.object({
    role: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
    targetRole: z.string().max(200).optional(),
  }).optional(),
})

/**
 * True when ResumeSchema's clamp transforms SHORTENED any field of `raw` —
 * i.e. the saved resume is missing content the client posted. Compares the raw
 * body to the parsed (clamped) output so it needs no duplicated cap constants:
 * a field is clamped exactly when its raw length exceeds the parsed length.
 * The save route surfaces this so "Saved!" doesn't hide a silent truncation.
 */
export function resumeClampedContent(raw: unknown, parsed: ResumeData): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  const strShrank = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' && a.length > b.length
  const arrShrank = (a: unknown, b: unknown) =>
    Array.isArray(a) && Array.isArray(b) && a.length > b.length

  if (strShrank(r.name, parsed.name)) return true
  if (strShrank(r.summary, parsed.summary)) return true
  if (arrShrank(r.experience, parsed.experience)) return true
  const rawExp = Array.isArray(r.experience) ? r.experience : []
  for (let i = 0; i < (parsed.experience?.length ?? 0); i++) {
    const rb = (rawExp[i] as { bullets?: unknown })?.bullets
    const pb = parsed.experience?.[i]?.bullets
    if (arrShrank(rb, pb)) return true
    for (let j = 0; j < (pb?.length ?? 0); j++) {
      if (strShrank((rb as unknown[])?.[j], pb?.[j])) return true
    }
  }
  if (arrShrank(r.education, parsed.education)) return true
  if (arrShrank(r.skills, parsed.skills)) return true
  const rawSkills = Array.isArray(r.skills) ? r.skills : []
  for (let i = 0; i < (parsed.skills?.length ?? 0); i++) {
    if (arrShrank((rawSkills[i] as { items?: unknown })?.items, parsed.skills?.[i]?.items)) return true
  }
  if (arrShrank(r.projects, parsed.projects)) return true
  if (arrShrank(r.certifications, parsed.certifications)) return true
  if (arrShrank(r.customSections, parsed.customSections)) return true
  const rawCustom = Array.isArray(r.customSections) ? r.customSections : []
  for (let i = 0; i < (parsed.customSections?.length ?? 0); i++) {
    if (strShrank((rawCustom[i] as { content?: unknown })?.content, parsed.customSections?.[i]?.content)) return true
  }
  return false
}

// AI-input text CLAMPS instead of hard-rejecting at the cap: a saved resume's
// fullText can legally reach 100k (ResumeSchema.fullText), and handleSelectSaved
// feeds it straight in — a .max() there 400'd with "Validation failed" instead
// of letting the service slice-and-warn (checkATS/tailorResume already report
// inputTruncated). The min() floors stay (too-short IS a real structural error).
const AI_INPUT_MAX = 100_000
export const ATSCheckSchema = z.object({
  resumeText: z.string().min(50).transform((s) => s.slice(0, AI_INPUT_MAX)),
  jobDescription: z.string().transform((s) => s.slice(0, AI_INPUT_MAX)).optional(),
})

export const TailorSchema = z.object({
  resumeText: z.string().min(50).transform((s) => s.slice(0, AI_INPUT_MAX)),
  jobDescription: z.string().min(50).transform((s) => s.slice(0, AI_INPUT_MAX)),
  companyName: clampStr(200).optional(),
})

export const ParseResumeSchema = z.object({
  text: z.string().min(10).transform((s) => s.slice(0, AI_INPUT_MAX)),
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
