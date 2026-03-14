import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'

// ─── Resume CRUD ────────────────────────────────────────────────────────────

export async function listResumes(userId: string) {
  await connectDB()
  const user = await User.findById(userId).select('savedResumes targetRole currentTitle').lean()
  if (!user) return null

  const resumes = (user.savedResumes || []).map((r: Record<string, unknown>) => ({
    id: r.id || (r._id as { toString(): string })?.toString(),
    name: r.name || 'Untitled Resume',
    targetRole: r.targetRole || '',
    targetCompany: r.targetCompany || '',
    atsScore: r.atsScore ?? null,
    updatedAt: r.updatedAt || new Date().toISOString(),
  }))

  return {
    resumes,
    hasProfile: !!(user.targetRole || user.currentTitle),
  }
}

export async function saveResume(
  userId: string,
  data: {
    id?: string
    name: string
    targetRole?: string
    targetCompany?: string
    template?: string
    atsScore?: number | null
    sections?: Record<string, string>
    fullText?: string
  }
) {
  await connectDB()
  const { id, name, targetRole, targetCompany, template, atsScore, sections, fullText } = data

  if (id) {
    await User.updateOne(
      { _id: userId, 'savedResumes.id': id },
      {
        $set: {
          'savedResumes.$.name': name,
          'savedResumes.$.targetRole': targetRole || '',
          'savedResumes.$.targetCompany': targetCompany || '',
          'savedResumes.$.template': template || 'professional',
          'savedResumes.$.atsScore': atsScore ?? null,
          'savedResumes.$.sections': sections || {},
          'savedResumes.$.fullText': fullText || '',
          'savedResumes.$.updatedAt': new Date().toISOString(),
        },
      }
    )
    return { id }
  }

  const newId = crypto.randomUUID()
  const resumeDoc = {
    id: newId,
    name,
    targetRole: targetRole || '',
    targetCompany: targetCompany || '',
    template: template || 'professional',
    atsScore: atsScore ?? null,
    sections: sections || {},
    fullText: fullText || '',
    updatedAt: new Date().toISOString(),
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
