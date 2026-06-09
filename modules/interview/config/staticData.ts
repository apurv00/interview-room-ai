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
  /** Legacy free-form category label (kept until UI migrates to categorySlug). */
  category: string
  /** Data-driven taxonomy bucket → Category.slug. */
  categorySlug?: string
}

export interface StaticDepth {
  slug: string
  label: string
  icon: string
  description: string
  applicableDomains?: string[]
}

export const STATIC_DOMAINS: StaticDomain[] = [
  // Programming
  { slug: 'frontend', label: 'Frontend Engineer', shortLabel: 'FE', icon: '🖥', color: 'indigo', category: 'engineering', categorySlug: 'programming', description: 'UI development, React/Angular/Vue, web performance, accessibility, and responsive design.' },
  { slug: 'backend', label: 'Backend / Infra Engineer', shortLabel: 'BE', icon: '🔧', color: 'indigo', category: 'engineering', categorySlug: 'programming', description: 'APIs, databases, system design, microservices, scalability, infrastructure, CI/CD, and cloud platforms.' },
  { slug: 'sdet', label: 'SDET / QA', shortLabel: 'QA', icon: '🧪', color: 'indigo', category: 'engineering', categorySlug: 'programming', description: 'Test automation, quality strategy, CI/CD testing, performance testing, and reliability.' },
  // Data & AI
  { slug: 'data-science', label: 'Data Science / ML', shortLabel: 'DS', icon: '📊', color: 'indigo', category: 'engineering', categorySlug: 'data-ai', description: 'ML models, statistics, experimentation, data storytelling, and business impact.' },
  // Product
  { slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', color: 'indigo', category: 'product', categorySlug: 'product', description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.' },
  // Design
  { slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', color: 'indigo', category: 'product', categorySlug: 'design', description: 'User research, design thinking, prototyping, and design system expertise.' },
  // Business
  { slug: 'business', label: 'Business & Strategy', shortLabel: 'BIZ', icon: '🎓', color: 'indigo', category: 'business', categorySlug: 'business', description: 'Strategy, consulting, finance, marketing, sales, leadership, and cross-functional impact.' },
  // General — fallback when no domain fits, shown last
  { slug: 'general', label: 'General / Any Role', shortLabel: 'GEN', icon: '🎯', color: 'indigo', category: 'general', categorySlug: 'general', description: 'General interview practice — problem-solving, communication, leadership, teamwork, and adaptability.' },
]

export const STATIC_DEPTHS: StaticDepth[] = [
  { slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', description: 'Behavioral probing — motivation, leadership, conflict resolution, self-awareness, and culture fit.' },
  { slug: 'technical', label: 'Technical Deep Dive', icon: '⚙️', description: 'Domain-specific technical depth — knowledge, problem-solving, trends, and practical application.' },
  { slug: 'case-study', label: 'Case Study', icon: '📋', description: 'Scenario-based problem-solving — structured thinking, frameworks, and business reasoning.', applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'] },
  { slug: 'system-design', label: 'System Design', icon: '🏗️', description: 'Architecture and system design — scalability, trade-offs, component design, and technical breadth.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet', 'general'] },
  { slug: 'coding', label: 'Coding Challenge', icon: '💻', description: 'Live coding problem-solving — algorithm design, implementation, testing, and optimization.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'] },
]

export interface StaticCategory {
  slug: string
  label: string
  icon: string
  description: string
  sortOrder: number
}

// Instant-render mirror of BUILT_IN_CATEGORIES (shared/db/seed.ts), replaced by
// the /api/categories fetch. 'general' is the search-fallback escape (sortOrder
// 99) — the category grid renders it as an escape, not a browseable card.
export const STATIC_CATEGORIES: StaticCategory[] = [
  { slug: 'programming', label: 'Programming', icon: '💻', description: 'Software & web engineering roles', sortOrder: 1 },
  { slug: 'data-ai', label: 'Data & AI', icon: '📊', description: 'Data science, ML, and analytics', sortOrder: 2 },
  { slug: 'core-engineering', label: 'Core Engineering', icon: '⚙️', description: 'Mechanical, civil, electrical & more', sortOrder: 3 },
  { slug: 'business', label: 'Business', icon: '📈', description: 'Strategy, finance, ops, marketing', sortOrder: 4 },
  { slug: 'product', label: 'Product', icon: '🎯', description: 'Product management & analytics', sortOrder: 5 },
  { slug: 'design', label: 'Design', icon: '🎨', description: 'UX, UI, and product design', sortOrder: 6 },
  { slug: 'general', label: 'General / Other', icon: '🧭', description: 'Any role — versatile practice', sortOrder: 99 },
]
