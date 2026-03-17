// Static interview domain & depth data for instant client rendering.
// This avoids waiting for API/DB round-trips on initial page load.
// If CMS adds new domains/depths, they'll appear after the background fetch completes.

export interface StaticDomain {
  slug: string
  label: string
  shortLabel: string
  icon: string
  description: string
  color: string
  category: string
}

export interface StaticDepth {
  slug: string
  label: string
  icon: string
  description: string
}

export const STATIC_DOMAINS: StaticDomain[] = [
  { slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', color: 'indigo', category: 'business', description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.' },
  { slug: 'swe', label: 'Software Engineer', shortLabel: 'SWE', icon: '💻', color: 'indigo', category: 'engineering', description: 'System design, coding practices, debugging, collaboration, and technical leadership.' },
  { slug: 'sales', label: 'Sales', shortLabel: 'Sales', icon: '📈', color: 'indigo', category: 'business', description: 'Pipeline management, deal closing, relationship building, and revenue growth.' },
  { slug: 'mba', label: 'MBA / Business', shortLabel: 'MBA', icon: '🎓', color: 'indigo', category: 'business', description: 'Business strategy, leadership, analytical thinking, and cross-functional impact.' },
  { slug: 'data-science', label: 'Data Scientist', shortLabel: 'DS', icon: '📊', color: 'indigo', category: 'engineering', description: 'Statistical modeling, ML pipelines, data storytelling, and business impact.' },
  { slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', color: 'indigo', category: 'design', description: 'User research, design thinking, prototyping, and design system expertise.' },
  { slug: 'marketing', label: 'Marketing', shortLabel: 'MKT', icon: '📣', color: 'indigo', category: 'business', description: 'Growth strategies, campaign management, brand building, and analytics.' },
  { slug: 'finance', label: 'Finance', shortLabel: 'FIN', icon: '💰', color: 'indigo', category: 'business', description: 'Financial modeling, risk assessment, strategic planning, and regulatory compliance.' },
  { slug: 'consulting', label: 'Consulting', shortLabel: 'CON', icon: '🧩', color: 'indigo', category: 'business', description: 'Problem structuring, client management, frameworks, and executive communication.' },
  { slug: 'devops', label: 'DevOps / SRE', shortLabel: 'SRE', icon: '⚙️', color: 'indigo', category: 'engineering', description: 'Infrastructure, CI/CD, reliability engineering, and incident management.' },
  { slug: 'hr', label: 'Human Resources', shortLabel: 'HR', icon: '🤝', color: 'indigo', category: 'operations', description: 'Talent acquisition, employee relations, organizational development, and compliance.' },
  { slug: 'legal', label: 'Legal', shortLabel: 'LGL', icon: '⚖️', color: 'indigo', category: 'operations', description: 'Contract negotiation, regulatory compliance, risk management, and legal strategy.' },
]

export const STATIC_DEPTHS: StaticDepth[] = [
  { slug: 'hr-screening', label: 'HR Screening', icon: '🤝', description: 'Standard behavioral screening — motivation, culture fit, and communication skills.' },
  { slug: 'behavioral', label: 'Behavioral Deep Dive', icon: '🧠', description: 'In-depth behavioral probing — leadership, conflict resolution, teamwork, and decision-making.' },
  { slug: 'technical', label: 'Technical Interview', icon: '⚙️', description: 'Domain-specific technical questions — depth of knowledge, problem-solving, and technical communication.' },
  { slug: 'case-study', label: 'Case Study', icon: '📋', description: 'Situational business cases — structured thinking, frameworks, and creative problem-solving.' },
  { slug: 'domain-knowledge', label: 'Domain Knowledge', icon: '📚', description: 'Industry and function-specific knowledge probing — trends, best practices, and practical application.' },
  { slug: 'culture-fit', label: 'Culture Fit', icon: '🌱', description: 'Values alignment, work style, team dynamics, and organizational culture match.' },
]
