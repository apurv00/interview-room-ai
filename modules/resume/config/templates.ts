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
    color: 'indigo',
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

export const TEMPLATE_COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  indigo: { bg: 'bg-indigo-500/10', border: 'border-indigo-500/20', text: 'text-indigo-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400' },
  violet: { bg: 'bg-violet-500/10', border: 'border-violet-500/20', text: 'text-violet-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400' },
  cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/20', text: 'text-cyan-400' },
  rose: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', text: 'text-rose-400' },
  slate: { bg: 'bg-slate-500/10', border: 'border-slate-500/20', text: 'text-slate-400' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-400' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400' },
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/20', text: 'text-orange-400' },
}
