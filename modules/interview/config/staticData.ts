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
  applicableDomains?: string[]
}

export const STATIC_DOMAINS: StaticDomain[] = [
  // General
  { slug: 'general', label: 'General / Any Role', shortLabel: 'GEN', icon: '🎯', color: 'indigo', category: 'general', description: 'General interview practice — problem-solving, communication, leadership, teamwork, and adaptability.' },
  // Engineering
  { slug: 'frontend', label: 'Frontend Engineer', shortLabel: 'FE', icon: '🖥', color: 'indigo', category: 'engineering', description: 'UI development, React/Angular/Vue, web performance, accessibility, and responsive design.' },
  { slug: 'backend', label: 'Backend / Infra Engineer', shortLabel: 'BE', icon: '🔧', color: 'indigo', category: 'engineering', description: 'APIs, databases, system design, microservices, scalability, infrastructure, CI/CD, and cloud platforms.' },
  { slug: 'sdet', label: 'SDET / QA', shortLabel: 'QA', icon: '🧪', color: 'indigo', category: 'engineering', description: 'Test automation, quality strategy, CI/CD testing, performance testing, and reliability.' },
  { slug: 'data-science', label: 'Data Science / ML', shortLabel: 'DS', icon: '📊', color: 'indigo', category: 'engineering', description: 'ML models, statistics, experimentation, data storytelling, and business impact.' },
  // Product & Design
  { slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', color: 'indigo', category: 'product', description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.' },
  { slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', color: 'indigo', category: 'product', description: 'User research, design thinking, prototyping, and design system expertise.' },
  // Business
  { slug: 'business', label: 'Business & Strategy', shortLabel: 'BIZ', icon: '🎓', color: 'indigo', category: 'business', description: 'Strategy, consulting, finance, marketing, sales, leadership, and cross-functional impact.' },
]

export const STATIC_DEPTHS: StaticDepth[] = [
  { slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', description: 'Behavioral probing — motivation, leadership, conflict resolution, self-awareness, and culture fit.' },
  { slug: 'technical', label: 'Technical Deep Dive', icon: '⚙️', description: 'Domain-specific technical depth — knowledge, problem-solving, trends, and practical application.' },
  { slug: 'case-study', label: 'Case Study', icon: '📋', description: 'Scenario-based problem-solving — structured thinking, frameworks, and business reasoning.', applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'] },
  { slug: 'system-design', label: 'System Design', icon: '🏗️', description: 'Architecture and system design — scalability, trade-offs, component design, and technical breadth.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet', 'general'] },
  { slug: 'coding', label: 'Coding Challenge', icon: '💻', description: 'Live coding problem-solving — algorithm design, implementation, testing, and optimization.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'] },
]
