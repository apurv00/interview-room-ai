import { describe, it, expect } from 'vitest'
import { computeQuickWins } from '../config/quickWins'

const SOLID = {
  summary: 'Backend engineer with 4 years building payment systems at scale; led a team of 3 through two major launches and 40% latency cuts.',
  contactInfo: { fullName: 'A', email: 'a@x.com', phone: '9876543210' },
  experience: [
    { bullets: ['Built payment reconciliation cutting manual work 60%', 'Shipped UPI autopay serving 2M users', 'Cut p99 latency 40% via connection pooling'] },
  ],
  skills: [{ items: ['Node.js', 'MongoDB', 'Redis', 'Kafka', 'TypeScript', 'Docker', 'K8s', 'SQL'] }],
  projects: [],
}

describe('computeQuickWins (package 10 — deterministic, zero LLM)', () => {
  it('a solid resume yields zero wins', () => {
    expect(computeQuickWins(SOLID)).toEqual([])
  })

  it('flags the classic gaps: short summary, unquantified bullets, weak verbs, thin skills, missing contact', () => {
    const wins = computeQuickWins({
      summary: 'Engineer.',
      contactInfo: { fullName: 'A', email: 'a@x.com' }, // no phone
      experience: [{ bullets: ['Responsible for backend work', 'Worked on the payments team', 'Helped with releases'] }],
      skills: [{ items: ['Java'] }],
    })
    const ids = wins.map((w) => w.id)
    expect(ids).toContain('summary')
    expect(ids).toContain('quantify') // 0/3 bullets carry a number
    expect(ids).toContain('verbs')
    expect(ids).toContain('more-skills')
    expect(ids).toContain('contact')
  })

  it('fresher with no experience AND no projects gets the projects win; long bullets get tighten', () => {
    const fresher = computeQuickWins({ summary: SOLID.summary, contactInfo: SOLID.contactInfo, experience: [], skills: SOLID.skills, projects: [] })
    expect(fresher.map((w) => w.id)).toContain('projects')
    const long = computeQuickWins({
      ...SOLID,
      experience: [{ bullets: ['Shipped a 2M-user feature ' + 'and then kept going with more and more detail about every stakeholder meeting '.repeat(3)] }],
    })
    expect(long.map((w) => w.id)).toContain('tighten')
  })

  it('caps at 6 wins — a card, not a lecture', () => {
    const empty = computeQuickWins({})
    expect(empty.length).toBeLessThanOrEqual(6)
  })
})
