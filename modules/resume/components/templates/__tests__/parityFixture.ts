import type { ResumeData } from '../../../validators/resume'

/** Shared input for the legacy parity gate — identical on origin/main and the branch. */
export const FIXTURE = {
  name: 'Parity Fixture',
  template: 'professional',
  contactInfo: {
    fullName: 'Alex Johnson',
    email: 'alex.johnson@email.com',
    phone: '(555) 123-4567',
    location: 'San Francisco, CA',
    linkedin: 'linkedin.com/in/alexjohnson',
    website: 'alexjohnson.dev',
    github: 'github.com/alexjohnson',
  },
  summary:
    'Results-driven software engineer with 5+ years of experience building scalable web applications. Led cross-functional teams to deliver high-impact products serving millions of users.',
  experience: [
    {
      id: 'exp-1',
      company: 'TechCorp Inc.',
      title: 'Senior Software Engineer',
      location: 'San Francisco, CA',
      startDate: 'Jan 2022',
      endDate: '',
      bullets: [
        'Architected a real-time analytics platform processing 2M+ events daily, reducing latency by 40%',
        'Led migration from monolith to microservices, improving deployment velocity by 3x',
        'Mentored 4 junior engineers, resulting in 2 promotions within 12 months',
      ],
    },
    {
      id: 'exp-2',
      company: 'StartupXYZ',
      title: 'Full Stack Developer',
      location: 'Remote',
      startDate: 'Mar 2019',
      endDate: 'Dec 2021',
      bullets: [
        'Built customer-facing dashboard serving 50K+ monthly active users with React and Node.js',
        'Implemented CI/CD pipeline reducing deployment time from 2 hours to 15 minutes',
      ],
    },
  ],
  education: [
    {
      id: 'edu-1',
      institution: 'Stanford University',
      degree: 'B.S. Computer Science',
      field: 'Artificial Intelligence',
      graduationDate: 'Jun 2019',
      gpa: '3.8',
      honors: 'Magna Cum Laude',
    },
  ],
  skills: [
    { category: 'Languages', items: ['TypeScript', 'Python', 'Go', 'SQL'] },
    { category: 'Frameworks', items: ['React', 'Next.js', 'Node.js', 'FastAPI'] },
    { category: 'Tools', items: ['AWS', 'Docker', 'Kubernetes', 'PostgreSQL'] },
  ],
  projects: [
    {
      id: 'proj-1',
      name: 'AI Resume Builder',
      description: 'Open-source resume builder with AI-powered content suggestions and ATS optimization.',
      technologies: ['Next.js', 'Claude AI', 'MongoDB'],
      url: 'github.com/alexj/resume-builder',
    },
  ],
  certifications: [
    { name: 'AWS Solutions Architect', issuer: 'Amazon Web Services', date: '2023' },
  ],
  customSections: [
    { id: 'cs-1', title: 'Side Projects', content: 'Built a CLI tool with 1k+ GitHub stars.' },
    { id: 'cs-2', title: 'Interests', content: 'Open source, climbing, photography.' },
    { id: 'cs-3', title: 'Volunteer Work', content: 'Mentor at Code2040.' },
  ],
} as unknown as ResumeData

export const LEGACY_IDS = [
  'professional',
  'technical',
  'creative',
  'executive',
  'career-change',
  'entry-level',
  'minimalist',
  'academic',
  'federal',
  'startup',
] as const

/**
 * Sort class-token order within every `class="..."`. Cosmetic Tailwind reordering
 * has zero rendering/geometry effect; any added/removed/changed token still differs
 * after sorting, so genuine drift is still caught.
 */
export function normalizeClassOrder(html: string): string {
  return html.replace(/class="([^"]*)"/g, (_m, classes: string) => {
    const sorted = classes.split(/\s+/).filter(Boolean).sort().join(' ')
    return `class="${sorted}"`
  })
}
