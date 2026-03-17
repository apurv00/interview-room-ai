import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import type { ResumeData } from '../validators/resume'

const MAX_RESUMES = 3

// ─── Resume CRUD ────────────────────────────────────────────────────────────

export async function listResumes(userId: string) {
  await connectDB()
  const user = await User.findById(userId).select('savedResumes targetRole currentTitle').lean()
  if (!user) return null

  const resumes = (user.savedResumes || []).map((r: Record<string, unknown>) => ({
    id: r.id || (r._id as { toString(): string })?.toString(),
    name: r.name || 'Untitled Resume',
    template: r.template || 'professional',
    targetRole: r.targetRole || '',
    targetCompany: r.targetCompany || '',
    atsScore: r.atsScore ?? null,
    updatedAt: r.updatedAt || new Date().toISOString(),
  }))

  return {
    resumes,
    count: resumes.length,
    limit: MAX_RESUMES,
    hasProfile: !!(user.targetRole || user.currentTitle),
  }
}

export async function getResume(userId: string, resumeId: string) {
  await connectDB()
  const user = await User.findById(userId).select('savedResumes').lean()
  if (!user) return null

  const resume = (user.savedResumes || []).find(
    (r: Record<string, unknown>) => r.id === resumeId
  )
  return resume || null
}

export async function saveResume(userId: string, data: ResumeData) {
  await connectDB()
  const { id, name, template, targetRole, targetCompany, atsScore,
    contactInfo, summary, experience, education, skills,
    projects, certifications, customSections, fullText } = data

  // Build fullText from structured data for ATS/tailor operations
  const computedFullText = fullText || buildFullText(data)

  if (id) {
    // Update existing resume
    await User.updateOne(
      { _id: userId, 'savedResumes.id': id },
      {
        $set: {
          'savedResumes.$.name': name,
          'savedResumes.$.template': template || 'professional',
          'savedResumes.$.targetRole': targetRole || '',
          'savedResumes.$.targetCompany': targetCompany || '',
          'savedResumes.$.atsScore': atsScore ?? null,
          'savedResumes.$.contactInfo': contactInfo || { fullName: '', email: '' },
          'savedResumes.$.summary': summary || '',
          'savedResumes.$.experience': experience || [],
          'savedResumes.$.education': education || [],
          'savedResumes.$.skills': skills || [],
          'savedResumes.$.projects': projects || [],
          'savedResumes.$.certifications': certifications || [],
          'savedResumes.$.customSections': customSections || [],
          'savedResumes.$.fullText': computedFullText,
          'savedResumes.$.updatedAt': new Date().toISOString(),
        },
      }
    )
    return { id }
  }

  // Check resume limit before creating new
  const user = await User.findById(userId).select('savedResumes').lean()
  const currentCount = (user?.savedResumes || []).length
  if (currentCount >= MAX_RESUMES) {
    return {
      error: 'Resume limit reached. Delete an existing resume to create a new one.',
      code: 'RESUME_LIMIT' as const,
    }
  }

  const newId = crypto.randomUUID()
  const now = new Date().toISOString()
  const resumeDoc = {
    id: newId,
    name,
    template: template || 'professional',
    targetRole: targetRole || '',
    targetCompany: targetCompany || '',
    atsScore: atsScore ?? null,
    contactInfo: contactInfo || { fullName: '', email: '' },
    summary: summary || '',
    experience: experience || [],
    education: education || [],
    skills: skills || [],
    projects: projects || [],
    certifications: certifications || [],
    customSections: customSections || [],
    fullText: computedFullText,
    createdAt: now,
    updatedAt: now,
  }

  await User.updateOne(
    { _id: userId },
    { $push: { savedResumes: resumeDoc } }
  )
  return { id: newId, created: true }
}

export async function deleteResume(userId: string, resumeId: string) {
  await connectDB()
  await User.updateOne(
    { _id: userId },
    { $pull: { savedResumes: { id: resumeId } } }
  )
  return { success: true }
}

// ─── User Profile Context ───────────────────────────────────────────────────

export async function getUserProfileContext(userId: string): Promise<string> {
  await connectDB()
  const profile = await User.findById(userId).select(
    'currentTitle currentIndustry experienceLevel topSkills educationLevel'
  ).lean()

  let context = ''
  if (profile?.currentTitle) context += `Current title: ${profile.currentTitle}. `
  if (profile?.currentIndustry) context += `Industry: ${profile.currentIndustry}. `
  if (profile?.experienceLevel) context += `Experience: ${profile.experienceLevel} years. `
  if (profile?.topSkills?.length) context += `Key skills: ${profile.topSkills.join(', ')}. `
  return context
}

// ─── Import from Profile ────────────────────────────────────────────────────

export async function getProfileForResume(userId: string) {
  await connectDB()
  const user = await User.findById(userId).select(
    'name email currentTitle currentIndustry topSkills educationLevel linkedinUrl targetRole'
  ).lean()
  if (!user) return null

  return {
    contactInfo: {
      fullName: user.name || '',
      email: user.email || '',
      linkedin: user.linkedinUrl || '',
    },
    summary: user.currentTitle
      ? `Experienced ${user.currentTitle}${user.currentIndustry ? ` in the ${user.currentIndustry} industry` : ''}.`
      : '',
    skills: user.topSkills?.length
      ? [{ category: 'Core Skills', items: user.topSkills }]
      : [],
    targetRole: user.targetRole || '',
  }
}

// ─── Resume-to-Interview Config ────────────────────────────────────────────

const ROLE_TO_DOMAIN: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /product\s*manag|^pm$/i, domain: 'pm' },
  { pattern: /frontend|front.end|react|angular|vue|ui\s*develop/i, domain: 'frontend' },
  { pattern: /backend|back.end|server|api\s*develop|java\b|python\b|golang|node/i, domain: 'backend' },
  { pattern: /sdet|qa\s*engineer|test\s*autom|quality\s*assur/i, domain: 'sdet' },
  { pattern: /devops|sre|infrastructure|platform\s*eng/i, domain: 'devops' },
  { pattern: /software|developer|engineer|fullstack|full.stack|swe/i, domain: 'backend' },
  { pattern: /data\s*scien|machine\s*learn|ml\s*engineer|data\s*analy/i, domain: 'data-science' },
  { pattern: /design|ux|ui(?!\s*develop)|creative\s*director/i, domain: 'design' },
  { pattern: /market|growth|brand|content\s*strat/i, domain: 'marketing' },
  { pattern: /financ|accounting|controller|treasury/i, domain: 'finance' },
  { pattern: /sale|account\s*exec|business\s*develop/i, domain: 'sales' },
  { pattern: /mba|strateg|consult|operations|general\s*manag/i, domain: 'business' },
]

function inferDomainFromRole(role: string): string | null {
  for (const { pattern, domain } of ROLE_TO_DOMAIN) {
    if (pattern.test(role)) return domain
  }
  return null
}

function inferExperienceLevel(experience: Array<{ startDate?: string; endDate?: string }>): '0-2' | '3-6' | '7+' {
  if (!experience?.length) return '0-2'

  let totalMonths = 0
  const now = new Date()

  for (const exp of experience) {
    if (!exp.startDate) continue
    const start = new Date(exp.startDate)
    const end = exp.endDate ? new Date(exp.endDate) : now

    if (isNaN(start.getTime())) continue
    const endDate = isNaN(end.getTime()) ? now : end

    const months = Math.max(0, (endDate.getFullYear() - start.getFullYear()) * 12 + (endDate.getMonth() - start.getMonth()))
    totalMonths += months
  }

  const years = totalMonths / 12
  if (years >= 7) return '7+'
  if (years >= 3) return '3-6'
  return '0-2'
}

export interface ResumeInterviewConfig {
  domain: string | null
  experience: '0-2' | '3-6' | '7+'
  resumeText: string
  resumeName: string
  targetRole: string
  targetCompany: string
}

export async function buildInterviewConfig(userId: string, resumeId: string): Promise<ResumeInterviewConfig | null> {
  await connectDB()
  const user = await User.findById(userId).select('savedResumes').lean()
  if (!user) return null

  const resume = (user.savedResumes || []).find(
    (r: Record<string, unknown>) => r.id === resumeId
  ) as Record<string, unknown> | undefined
  if (!resume) return null

  const targetRole = (resume.targetRole as string) || ''
  const domain = inferDomainFromRole(targetRole)
  const experience = inferExperienceLevel(resume.experience as Array<{ startDate?: string; endDate?: string }> || [])

  // Build full text for AI context
  const fullText = (resume.fullText as string) || ''

  return {
    domain,
    experience,
    resumeText: fullText,
    resumeName: (resume.name as string) || 'Untitled Resume',
    targetRole,
    targetCompany: (resume.targetCompany as string) || '',
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildFullText(data: ResumeData): string {
  const parts: string[] = []

  if (data.contactInfo) {
    const c = data.contactInfo
    if (c.fullName) parts.push(c.fullName)
    if (c.email) parts.push(c.email)
    if (c.phone) parts.push(c.phone)
    if (c.location) parts.push(c.location)
  }

  if (data.summary) parts.push(data.summary)

  if (data.experience?.length) {
    parts.push('EXPERIENCE')
    for (const exp of data.experience) {
      parts.push(`${exp.title} at ${exp.company}`)
      if (exp.location) parts.push(exp.location)
      parts.push(`${exp.startDate} - ${exp.endDate || 'Present'}`)
      parts.push(...exp.bullets)
    }
  }

  if (data.education?.length) {
    parts.push('EDUCATION')
    for (const edu of data.education) {
      parts.push(`${edu.degree}${edu.field ? ` in ${edu.field}` : ''} - ${edu.institution}`)
      if (edu.graduationDate) parts.push(edu.graduationDate)
    }
  }

  if (data.skills?.length) {
    parts.push('SKILLS')
    for (const cat of data.skills) {
      parts.push(`${cat.category}: ${cat.items.join(', ')}`)
    }
  }

  if (data.projects?.length) {
    parts.push('PROJECTS')
    for (const proj of data.projects) {
      parts.push(`${proj.name}: ${proj.description}`)
      if (proj.technologies?.length) parts.push(`Technologies: ${proj.technologies.join(', ')}`)
    }
  }

  if (data.certifications?.length) {
    parts.push('CERTIFICATIONS')
    for (const cert of data.certifications) {
      parts.push(`${cert.name} - ${cert.issuer}`)
    }
  }

  if (data.customSections?.length) {
    for (const sec of data.customSections) {
      parts.push(sec.title.toUpperCase())
      parts.push(sec.content)
    }
  }

  return parts.join('\n')
}
