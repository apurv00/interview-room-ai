export interface ResumeTemplate {
  id: string
  name: string
  desc: string
  sections: string[]
  industries: string[]
  color: string
}

export const RESUME_TEMPLATES: ResumeTemplate[] = [
  {
    id: 'professional',
    name: 'Professional',
    desc: 'Clean, traditional layout perfect for corporate roles.',
    sections: ['Summary', 'Experience', 'Education', 'Skills'],
    industries: ['Finance', 'Consulting', 'Enterprise'],
    color: 'blue',
  },
  {
    id: 'technical',
    name: 'Technical',
    desc: 'Skills-forward layout ideal for engineering roles.',
    sections: ['Technical Skills', 'Experience', 'Projects', 'Education'],
    industries: ['Tech', 'Engineering', 'Data Science'],
    color: 'emerald',
  },
  {
    id: 'creative',
    name: 'Creative',
    desc: 'Modern layout with visual hierarchy for design roles.',
    sections: ['Portfolio', 'Experience', 'Skills', 'Education'],
    industries: ['Design', 'Marketing', 'Media'],
    color: 'violet',
  },
  {
    id: 'executive',
    name: 'Executive',
    desc: 'Leadership-focused layout for senior positions.',
    sections: ['Executive Summary', 'Key Achievements', 'Experience', 'Board & Advisory'],
    industries: ['C-Suite', 'VP+', 'Director'],
    color: 'amber',
  },
  {
    id: 'career-change',
    name: 'Career Change',
    desc: 'Skills-based format that emphasizes transferable abilities.',
    sections: ['Objective', 'Core Competencies', 'Relevant Experience', 'Education'],
    industries: ['All Industries'],
    color: 'cyan',
  },
  {
    id: 'entry-level',
    name: 'Entry Level',
    desc: 'Education-forward for new graduates and early career.',
    sections: ['Education', 'Projects', 'Internships', 'Skills', 'Activities'],
    industries: ['All Industries'],
    color: 'rose',
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    desc: 'Clean single-column design with ample whitespace.',
    sections: ['Summary', 'Experience', 'Education', 'Skills'],
    industries: ['All Industries'],
    color: 'slate',
  },
  {
    id: 'academic',
    name: 'Academic',
    desc: 'Publication and research focused for academia.',
    sections: ['Education', 'Research', 'Publications', 'Teaching', 'Skills'],
    industries: ['Academia', 'Research', 'Education'],
    color: 'blue',
  },
  {
    id: 'federal',
    name: 'Federal',
    desc: 'USAJobs-compatible format for government positions.',
    sections: ['Summary', 'Experience', 'Education', 'Certifications', 'Clearance'],
    industries: ['Government', 'Defense', 'Public Sector'],
    color: 'red',
  },
  {
    id: 'startup',
    name: 'Startup',
    desc: 'Modern, personality-forward layout for startup culture.',
    sections: ['About Me', 'Experience', 'Side Projects', 'Skills', 'Interests'],
    industries: ['Startups', 'Tech', 'Innovation'],
    color: 'orange',
  },
]

// Sample data used for template previews
export const SAMPLE_RESUME_DATA = {
  name: 'Sample Resume',
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
  summary: 'Results-driven software engineer with 5+ years of experience building scalable web applications. Led cross-functional teams to deliver high-impact products serving millions of users. Passionate about clean code, performance optimization, and mentoring junior developers.',
  experience: [
    {
      id: 'exp-1',
      company: 'TechCorp Inc.',
      title: 'Senior Software Engineer',
      location: 'San Francisco, CA',
      startDate: 'Jan 2022',
      endDate: '',
      bullets: [
        'Architected and launched a real-time analytics platform processing 2M+ events daily, reducing latency by 40%',
        'Led migration from monolith to microservices architecture, improving deployment velocity by 3x',
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
  customSections: [],
}

export const TEMPLATE_COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400' },
  violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/20', text: 'text-violet-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
  cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/20', text: 'text-cyan-400' },
  rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', text: 'text-rose-400' },
  slate: { bg: 'bg-[#eff3f4]', border: 'border-[#e1e8ed]', text: 'text-[#8b98a5]' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400' },
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/20', text: 'text-orange-400' },
}
