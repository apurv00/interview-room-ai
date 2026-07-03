import { completion } from '@shared/services/modelRouter'
import { DATA_BOUNDARY_RULE, JSON_OUTPUT_RULE } from '@shared/services/promptSecurity'
import { getUserProfileContext } from './resumeService'
import { extractJSON } from '@shared/utils'
import { buildAtsCacheKey, getCachedAtsResult, setCachedAtsResult } from './atsCheckCache'
import { salvageTruncatedJson, normalizeParsedResume } from '@resume/lib/parseSalvage'

// ─── Enhance Section ────────────────────────────────────────────────────────

export async function enhanceSection(
  userId: string,
  data: { sectionType: string; currentContent: string; targetRole?: string; targetCompany?: string }
) {
  const profileContext = await getUserProfileContext(userId)

  const result = await completion({
    taskSlot: 'resume.enhance-section',
    system: `You are an expert resume writer. Enhance the given resume section to be more impactful, ATS-friendly, and quantified. ${profileContext}${data.targetRole ? `Target role: ${data.targetRole}. ` : ''}${data.targetCompany ? `Target company: ${data.targetCompany}. ` : ''}Keep the same factual content but improve language, add metrics where possible, and use strong action verbs. Return ONLY the enhanced text, no explanations.`,
    messages: [{ role: 'user', content: `Enhance this "${data.sectionType}" section:\n\n${data.currentContent}` }],
  })

  return { enhanced: result.text }
}

// ─── Enhance Bullets ────────────────────────────────────────────────────────

export async function enhanceBullets(
  userId: string,
  data: { bullets: string[]; context?: { role?: string; company?: string; targetRole?: string } }
) {
  const profileContext = await getUserProfileContext(userId)
  const ctx = data.context || {}

  const result = await completion({
    taskSlot: 'resume.enhance-bullets',
    system: `You are an expert resume writer. Enhance the given bullet points to be more impactful and ATS-friendly. ${profileContext}${ctx.role ? `Role: ${ctx.role}. ` : ''}${ctx.company ? `Company: ${ctx.company}. ` : ''}${ctx.targetRole ? `Target role: ${ctx.targetRole}. ` : ''}

Rules:
- Start each bullet with a strong action verb
- Include metrics and quantified achievements where possible
- Make bullets ATS-friendly with relevant keywords
- ${JSON_OUTPUT_RULE}`,
    messages: [{ role: 'user', content: `Enhance these bullet points:` }],
    contextData: { bullets: data.bullets },
  })

  const raw = result.text || '[]'
  const cleaned = extractJSON(raw)
  try {
    const bullets = JSON.parse(cleaned)
    return { bullets: Array.isArray(bullets) ? bullets : data.bullets }
  } catch {
    console.error('enhanceBullets JSON parse failed. Raw:', raw.slice(0, 300))
    return { bullets: data.bullets }
  }
}

// ─── Generate Full Resume ───────────────────────────────────────────────────

export async function generateFullResume(
  userId: string,
  data: {
    targetRole?: string
    targetCompany?: string
    currentSections?: Array<{ type: string; content: string }>
  }
) {
  const profileContext = await getUserProfileContext(userId)

  const existingContent = data.currentSections?.filter(s => s.content.trim())
    .map(s => `${s.type}: ${s.content.slice(0, 500)}`).join('\n\n') || 'No existing content.'

  const result = await completion({
    taskSlot: 'resume.generate-full',
    system: `You are an expert resume writer. Generate professional resume content based on the user's profile and any existing content. ${profileContext}${data.targetRole ? `Target role: ${data.targetRole}. ` : ''}${data.targetCompany ? `Target company: ${data.targetCompany}. ` : ''}Make content ATS-friendly with strong action verbs and quantified achievements.

${JSON_OUTPUT_RULE}
{"sections": [{"type": "summary", "content": "..."}, {"type": "experience", "content": "..."}, {"type": "education", "content": "..."}, {"type": "skills", "content": "..."}, {"type": "projects", "content": "..."}]}`,
    messages: [{ role: 'user', content: `Generate resume section suggestions. Existing content:\n\n${existingContent}` }],
  })

  const raw = result.text || '{}'
  const cleaned = extractJSON(raw)
  try {
    return JSON.parse(cleaned)
  } catch {
    console.error('generateFullResume JSON parse failed. Raw:', raw.slice(0, 300))
    return { sections: [] }
  }
}

// ─── ATS Check ──────────────────────────────────────────────────────────────

// 24k/8k (was 5k/3k): a normal 2-page resume exceeds 5,000 chars, so the
// check silently analyzed only the first ~page and scored keywords/sections
// it never saw. Input tokens are cheap; the output stays small.
const ATS_RESUME_CHARS = 24_000
const ATS_JD_CHARS = 8_000
// The input slice grew 6x but the output cap did not: a dense resume can make
// the model enumerate enough issues/keywords to hit the 2000-token default and
// truncate the JSON — which fails parse and 500s on EVERY retry (parse errors
// aren't cached). Retry once with a larger budget before giving up.
const ATS_RETRY_MAX_TOKENS = 6_000

export async function checkATS(data: { resumeText: string; jobDescription?: string }) {
  // UAT-024: content-keyed cache layer. Same (resume, JD) pair hits in
  // <100ms instead of waiting on the ~35s LLM round-trip. Misses fall
  // through to the LLM and persist on success.
  const cacheKey = buildAtsCacheKey(data)
  const inputTruncated = data.resumeText.length > ATS_RESUME_CHARS
  const cached = await getCachedAtsResult<AtsResultShape>(cacheKey)
  if (cached) {
    // outputTruncated is per-generation; a cached result was a clean parse.
    return { ...cached, cached: true as const, inputTruncated, outputTruncated: false }
  }

  const jdContext = data.jobDescription
    ? `\n\n<job_description>\n${data.jobDescription.slice(0, ATS_JD_CHARS)}\n</job_description>\nAlso check keyword alignment with this job description.`
    : ''

  const runCheck = (maxTokens?: number) => completion({
    ...(maxTokens ? { maxTokens } : {}),
    taskSlot: 'resume.ats-check',
    system: `${DATA_BOUNDARY_RULE}

You are an ATS (Applicant Tracking System) compatibility expert. Analyze a resume for ATS parsing issues and provide a compatibility score.

Check for:
1. Formatting issues (tables, columns, headers, graphics that ATS can't parse)
2. Missing standard section headers
3. Keyword optimization
4. Contact info placement
5. Date formatting consistency
6. File structure and readability

${JSON_OUTPUT_RULE}
{
  "score": number (0-100),
  "issues": [{"category": "formatting|keywords|structure|content", "severity": "critical|warning|info", "message": "description", "fix": "how to fix"}],
  "keywords": {"found": ["keywords found"], "missing": ["keywords missing"], "total": number},
  "formatting": {"score": number (0-100), "issues": ["formatting issues"]},
  "sections": {"found": ["sections found"], "missing": ["standard sections missing"], "recommended": ["recommended sections to add"]},
  "summary": "one sentence summary of ATS compatibility"
}`,
    messages: [{
      role: 'user',
      content: `<resume>\n${data.resumeText.slice(0, ATS_RESUME_CHARS)}\n</resume>${jdContext}\n\nAnalyze this resume for ATS compatibility.`,
    }],
  })

  let atsResult = await runCheck()
  if (atsResult.truncated) {
    atsResult = await runCheck(ATS_RETRY_MAX_TOKENS)
  }

  const raw = atsResult.text || '{}'
  const cleaned = extractJSON(raw)
  try {
    const result = JSON.parse(cleaned)
    // Ensure required fields have defaults
    const normalized: AtsResultShape = {
      score: result.score ?? 0,
      issues: Array.isArray(result.issues) ? result.issues : [],
      keywords: {
        found: result.keywords?.found || [],
        missing: result.keywords?.missing || [],
        total: result.keywords?.total || 0,
      },
      formatting: {
        score: result.formatting?.score ?? 0,
        issues: Array.isArray(result.formatting?.issues) ? result.formatting.issues : [],
      },
      sections: {
        found: result.sections?.found || [],
        missing: result.sections?.missing || [],
        recommended: result.sections?.recommended || [],
      },
      summary: result.summary || 'Unable to generate summary.',
    }
    // Persist on the happy path only — never cache a parse-error round. The
    // truncation flags are per-request (derived from input length / this
    // generation), so they ride OUTSIDE the cached blob.
    await setCachedAtsResult(cacheKey, normalized)
    return { ...normalized, cached: false as const, inputTruncated, outputTruncated: !!atsResult.truncated }
  } catch {
    console.error('checkATS JSON parse failed. Raw response:', raw.slice(0, 500))
    throw new Error('Failed to parse ATS analysis results. Please try again.')
  }
}

interface AtsResultShape {
  score: number
  issues: Array<{ category?: string; severity?: string; message?: string; fix?: string }>
  keywords: { found: string[]; missing: string[]; total: number }
  formatting: { score: number; issues: string[] }
  sections: { found: string[]; missing: string[]; recommended: string[] }
  summary: string
}

// ─── Tailor Resume ──────────────────────────────────────────────────────────

// 15k/8k (was 5k/3k): the output must contain the FULL rewritten resume, so
// everything past the input slice vanished from the tailored text — and
// "Save as New Resume" persisted the amputation. The output budget rises in
// taskSlots (resume.tailor 3000→8000) to carry the longer rewrite.
const TAILOR_RESUME_CHARS = 15_000
const TAILOR_JD_CHARS = 8_000
const TAILOR_RETRY_MAX_TOKENS = 10_000

export async function tailorResume(data: { resumeText: string; jobDescription: string; companyName?: string }) {
  const runTailor = (maxTokens?: number) => completion({
    ...(maxTokens ? { maxTokens } : {}),
    taskSlot: 'resume.tailor',
    system: `${DATA_BOUNDARY_RULE}

You are an expert resume tailor. Your job is to modify a candidate's resume to better match a specific job description while keeping all facts accurate. Never fabricate experience or skills.

Rules:
1. Reorder bullet points to prioritize relevant experience
2. Add relevant keywords from the JD naturally into existing descriptions
3. Quantify achievements where possible
4. Keep the resume ATS-friendly (clean formatting, standard section headers)

${data.companyName ? `Target company: ${data.companyName}. Tailor language to match this company's culture.` : ''}

${JSON_OUTPUT_RULE}
{
  "tailoredResume": "the full tailored resume text",
  "changes": [{"section": "string", "change": "what was changed", "reason": "why"}],
  "matchScore": number (0-100),
  "missingKeywords": ["keywords from JD not addressed"],
  "addedKeywords": ["keywords that were incorporated"]
}`,
    messages: [{
      role: 'user',
      content: `<resume>\n${data.resumeText.slice(0, TAILOR_RESUME_CHARS)}\n</resume>\n\n<job_description>\n${data.jobDescription.slice(0, TAILOR_JD_CHARS)}\n</job_description>\n\nTailor this resume for the job.`,
    }],
  })

  let tailorResult = await runTailor()
  if (tailorResult.truncated) {
    // A truncated rewrite is unparseable AND incomplete — retry once with an
    // explicit larger budget before giving up.
    tailorResult = await runTailor(TAILOR_RETRY_MAX_TOKENS)
  }

  const raw = tailorResult.text || '{}'
  const cleaned = extractJSON(raw)
  try {
    const result = JSON.parse(cleaned)
    return {
      tailoredResume: result.tailoredResume || '',
      changes: Array.isArray(result.changes) ? result.changes : [],
      matchScore: result.matchScore ?? 0,
      missingKeywords: Array.isArray(result.missingKeywords) ? result.missingKeywords : [],
      addedKeywords: Array.isArray(result.addedKeywords) ? result.addedKeywords : [],
      // Surfaced by the tailor page: warn when only part of the resume was
      // analyzed, and block Save-as-New when the rewrite itself is incomplete.
      inputTruncated: data.resumeText.length > TAILOR_RESUME_CHARS,
      outputTruncated: !!tailorResult.truncated,
    }
  } catch {
    console.error('tailorResume JSON parse failed. Raw response:', raw.slice(0, 500))
    throw new Error('Failed to parse tailoring results. Please try again.')
  }
}

// ─── Parse Resume Text to Structured Data ───────────────────────────────────

export interface ParsedResumeResult {
  /** Editor-safe partial resume data (ids/bullets normalized per section). */
  resume: Record<string, unknown>
  importedSections: string[]
  droppedSections: string[]
  truncated: boolean
}

const PARSE_SYSTEM = `Parse the resume into structured JSON. ${JSON_OUTPUT_RULE}
{contactInfo: {fullName, email, phone?, location?, linkedin?, website?, github?},
summary: str,
experience: [{id: "exp-N", company, title, location?, startDate: "Mon YYYY", endDate: "Mon YYYY"|"Present", bullets: [str]}],
education: [{id: "edu-N", institution, degree, field?, graduationDate?, gpa?, honors?}],
skills: [{category, items: [str]}],
projects: [{id: "proj-N", name, description, technologies: [str], url?}],
certifications: [{name, issuer, date?}]}
Use "Mon YYYY" dates. Group skills by category. Split experience into bullet points. Empty array for missing sections.`

// ~24k chars ≈ 6k input tokens — covers a dense 3-page resume. The old 6,000
// cap silently amputated everything past ~page 1.5 (education/skills/later
// roles) BEFORE the model saw it.
const PARSE_INPUT_CHARS = 24_000
// Explicit retry budget when the first completion truncates. Passing it as an
// opts override also bypasses any stale CMS slot cap.
const PARSE_RETRY_MAX_TOKENS = 8_000

/**
 * Structure raw resume text. Partial-tolerant by design:
 * - truncated completion → ONE retry with a larger explicit budget;
 * - malformed/cut-off JSON → salvageTruncatedJson repairs to the last
 *   complete value instead of discarding everything;
 * - output is normalized per section (junk dropped per-item) and reported as
 *   imported/dropped so callers can prefill what survived.
 * Returns null only when nothing usable could be recovered.
 */
export async function parseResumeToStructured(text: string): Promise<ParsedResumeResult | null> {
  const input = text.slice(0, PARSE_INPUT_CHARS)
  const messages = [{ role: 'user' as const, content: `Parse this resume into structured JSON:\n\n${input}` }]

  let parseResult = await completion({ taskSlot: 'resume.parse', system: PARSE_SYSTEM, messages })
  if (parseResult.truncated) {
    parseResult = await completion({
      taskSlot: 'resume.parse',
      system: PARSE_SYSTEM,
      messages,
      maxTokens: PARSE_RETRY_MAX_TOKENS,
    })
  }

  const raw = parseResult.text || '{}'
  const cleaned = extractJSON(raw)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    parsed = salvageTruncatedJson(cleaned)
    if (parsed) {
      console.error('parseResumeToStructured: salvaged truncated JSON. Raw head:', raw.slice(0, 200))
    } else {
      console.error('parseResumeToStructured JSON parse failed. Raw:', raw.slice(0, 500))
    }
  }
  if (!parsed || typeof parsed !== 'object') return null

  const normalized = normalizeParsedResume(parsed)
  if (normalized.importedSections.length === 0) return null

  return { ...normalized, truncated: !!parseResult.truncated }
}

// ─── Generate STAR Stories ─────────────────────────────────────────────────

export interface STARStory {
  experienceId: string
  originalBullet: string
  situation: string
  task: string
  action: string
  result: string
  targetQuestion: string
  skills: string[]
}

export async function generateSTARStories(
  userId: string,
  data: {
    experience: Array<{ id: string; company: string; title: string; bullets: string[] }>
    targetRole?: string
    jobDescription?: string
    count?: number
  }
): Promise<STARStory[]> {
  const profileContext = await getUserProfileContext(userId)
  const count = data.count || 6

  // Flatten bullets with context
  const bulletEntries = data.experience.flatMap(exp =>
    exp.bullets.map(bullet => ({
      id: exp.id,
      company: exp.company,
      title: exp.title,
      bullet,
    }))
  )

  if (bulletEntries.length === 0) return []

  const bulletsText = bulletEntries
    .map((b, i) => `${i + 1}. [${b.company} — ${b.title}] ${b.bullet}`)
    .join('\n')

  const jdContext = data.jobDescription
    ? `\n\nTarget job description:\n${data.jobDescription.slice(0, 3000)}`
    : ''

  const starResult = await completion({
    taskSlot: 'resume.gap-analysis',
    system: `You are an expert interview coach. Transform resume bullet points into compelling STAR stories for behavioral interview preparation. ${profileContext}${data.targetRole ? `Target role: ${data.targetRole}. ` : ''}

For each story:
- Pick the bullets with the most "story potential" (leadership, problem-solving, measurable impact)
- Map each to a common behavioral interview question it best answers
- Create a complete STAR breakdown: Situation (2-3 sentences), Task (1-2 sentences), Action (2-3 sentences), Result (1-2 sentences with metrics if possible)
- Never fabricate details — expand on what's implied by the bullet
- List 2-3 skills demonstrated

${JSON_OUTPUT_RULE}
[{ "bulletIndex": <number>, "situation": "...", "task": "...", "action": "...", "result": "...", "targetQuestion": "Tell me about a time when...", "skills": ["skill1", "skill2"] }]`,
    messages: [{
      role: 'user',
      content: `Generate ${count} STAR stories from these resume bullets:${jdContext}\n\n${bulletsText}`,
    }],
  })

  const responseText = starResult.text || ''
  const jsonMatch = responseText.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      bulletIndex: number
      situation: string
      task: string
      action: string
      result: string
      targetQuestion: string
      skills: string[]
    }>

    return parsed.map(story => {
      const entry = bulletEntries[story.bulletIndex - 1] || bulletEntries[0]
      return {
        experienceId: entry.id,
        originalBullet: entry.bullet,
        situation: story.situation,
        task: story.task,
        action: story.action,
        result: story.result,
        targetQuestion: story.targetQuestion,
        skills: story.skills || [],
      }
    })
  } catch {
    console.error('generateSTARStories JSON parse failed')
    return []
  }
}
