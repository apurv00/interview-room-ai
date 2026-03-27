/**
 * Migration script: generates 44 skill .md files from existing TS data structures.
 * Run once with: npx tsx scripts/migrate-to-skill-files.ts
 */
import * as fs from 'fs'
import * as path from 'path'

// We need to import the data — use dynamic requires since this is a script
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DOMAIN_DEPTH_OVERRIDES } = require('../modules/interview/config/domainDepthMatrix')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { QUESTION_POOL } = require('../modules/interview/config/questionPool')

const SKILLS_DIR = path.join(__dirname, '../modules/interview/skills')

const DOMAIN_LABELS: Record<string, string> = {
  frontend: 'Frontend Engineer',
  backend: 'Backend Engineer',
  sdet: 'SDET / QA',
  devops: 'DevOps / SRE',
  'data-science': 'Data Science',
  pm: 'Product Manager',
  design: 'Design / UX',
  business: 'Business & Strategy',
  marketing: 'Marketing',
  finance: 'Finance',
  sales: 'Sales',
}

const DEPTH_LABELS: Record<string, string> = {
  screening: 'Screening Interview',
  behavioral: 'Behavioral Interview',
  technical: 'Technical Interview',
  'case-study': 'Case Study Interview',
}

interface PoolQuestion {
  question: string
  experience: string
  targetCompetency: string
  followUpTheme?: string
}

function formatQuestions(questions: PoolQuestion[], experienceFilter: string): string {
  const filtered = questions.filter(q => q.experience === experienceFilter)
  if (filtered.length === 0) return ''
  return filtered.map((q, i) =>
    `${i + 1}. "${q.question}"\n   - Targets: ${q.targetCompetency}${q.followUpTheme ? ` → follow up on: ${q.followUpTheme}` : ''}`
  ).join('\n')
}

function generateSkillFile(domain: string, depth: string): string {
  const key = `${domain}:${depth}`
  const override = DOMAIN_DEPTH_OVERRIDES[key]
  const questions: PoolQuestion[] = QUESTION_POOL[key] || []

  if (!override) {
    console.warn(`No override found for ${key}`)
    return ''
  }

  const domainLabel = DOMAIN_LABELS[domain] || domain
  const depthLabel = DEPTH_LABELS[depth] || depth

  let md = `# ${domainLabel} — ${depthLabel}\n\n`

  // Interviewer Persona
  md += `## Interviewer Persona\n${override.interviewerTone}\n\n`

  // What This Depth Means (only for technical and case-study)
  if (override.technicalTranslation) {
    md += `## What This Depth Means for This Domain\n${override.technicalTranslation}\n\n`
  }

  // Question Strategy
  md += `## Question Strategy\n${override.questionStrategy}\n\n`

  // Anti-Patterns
  if (override.antiPatterns) {
    md += `## Anti-Patterns\n${override.antiPatterns}\n\n`
  }

  // Experience Calibration
  if (override.experienceCalibration) {
    md += `## Experience Calibration\n\n`
    if (override.experienceCalibration['0-2']) {
      md += `### Entry Level (0-2 years)\n${override.experienceCalibration['0-2']}\n\n`
    }
    if (override.experienceCalibration['3-6']) {
      md += `### Mid Level (3-6 years)\n${override.experienceCalibration['3-6']}\n\n`
    }
    if (override.experienceCalibration['7+']) {
      md += `### Senior (7+ years)\n${override.experienceCalibration['7+']}\n\n`
    }
  }

  // Scoring Emphasis
  if (override.scoringEmphasis) {
    md += `## Scoring Emphasis\n${override.scoringEmphasis}\n\n`
  }

  // Red Flags
  if (override.domainRedFlags?.length) {
    md += `## Red Flags\n`
    for (const flag of override.domainRedFlags) {
      md += `- ${flag}\n`
    }
    md += '\n'
  }

  // Sample Questions
  if (questions.length > 0) {
    md += `## Sample Questions\n\n`

    const entryQs = formatQuestions(questions, '0-2')
    if (entryQs) md += `### Entry Level (0-2 years)\n${entryQs}\n\n`

    const midQs = formatQuestions(questions, '3-6')
    if (midQs) md += `### Mid Level (3-6 years)\n${midQs}\n\n`

    const seniorQs = formatQuestions(questions, '7+')
    if (seniorQs) md += `### Senior (7+ years)\n${seniorQs}\n\n`

    const allQs = formatQuestions(questions, 'all')
    if (allQs) md += `### All Levels\n${allQs}\n`
  }

  return md.trimEnd() + '\n'
}

// Main
const DOMAINS = ['frontend', 'backend', 'sdet', 'devops', 'data-science', 'pm', 'design', 'business', 'marketing', 'finance', 'sales']
const DEPTHS = ['screening', 'behavioral', 'technical', 'case-study']

if (!fs.existsSync(SKILLS_DIR)) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
}

let count = 0
for (const domain of DOMAINS) {
  for (const depth of DEPTHS) {
    const filename = `${domain}-${depth}.md`
    const content = generateSkillFile(domain, depth)
    if (content) {
      fs.writeFileSync(path.join(SKILLS_DIR, filename), content)
      count++
      console.log(`Generated: ${filename}`)
    }
  }
}

console.log(`\nDone! Generated ${count} skill files in ${SKILLS_DIR}`)
