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
  // Engineering
  { slug: 'frontend', label: 'Frontend Engineer', shortLabel: 'FE', icon: '🖥', color: 'indigo', category: 'engineering', description: 'UI development, React/Angular/Vue, web performance, accessibility, and responsive design.' },
  { slug: 'backend', label: 'Backend Engineer', shortLabel: 'BE', icon: '🔧', color: 'indigo', category: 'engineering', description: 'APIs, databases, system design, microservices, scalability, and distributed systems.' },
  { slug: 'sdet', label: 'SDET / QA', shortLabel: 'QA', icon: '🧪', color: 'indigo', category: 'engineering', description: 'Test automation, quality strategy, CI/CD testing, performance testing, and reliability.' },
  { slug: 'devops', label: 'DevOps / SRE', shortLabel: 'SRE', icon: '⚙️', color: 'indigo', category: 'engineering', description: 'Infrastructure, CI/CD, monitoring, incident management, and cloud platforms.' },
  { slug: 'data-science', label: 'Data Science', shortLabel: 'DS', icon: '📊', color: 'indigo', category: 'engineering', description: 'ML models, statistics, experimentation, data storytelling, and business impact.' },
  // Product & Design
  { slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', color: 'indigo', category: 'product', description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.' },
  { slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', color: 'indigo', category: 'product', description: 'User research, design thinking, prototyping, and design system expertise.' },
  // Business
  { slug: 'business', label: 'Business & Strategy', shortLabel: 'BIZ', icon: '🎓', color: 'indigo', category: 'business', description: 'Strategy, consulting, leadership, analytical thinking, and cross-functional impact.' },
  { slug: 'marketing', label: 'Marketing', shortLabel: 'MKT', icon: '📣', color: 'indigo', category: 'business', description: 'Growth strategies, campaign management, brand building, and analytics.' },
  { slug: 'finance', label: 'Finance', shortLabel: 'FIN', icon: '💰', color: 'indigo', category: 'business', description: 'Financial modeling, risk assessment, strategic planning, and regulatory compliance.' },
  { slug: 'sales', label: 'Sales', shortLabel: 'Sales', icon: '📈', color: 'indigo', category: 'business', description: 'Pipeline management, deal closing, relationship building, and revenue growth.' },
]

export const STATIC_DEPTHS: StaticDepth[] = [
  { slug: 'screening', label: 'Screening Round', icon: '🤝', description: 'First-round behavioral screening — motivation, culture fit, communication, and values alignment.' },
  { slug: 'behavioral', label: 'Behavioral Round', icon: '🧠', description: 'Deep behavioral probing — leadership, conflict resolution, self-awareness, and decision-making.' },
  { slug: 'technical', label: 'Technical Round', icon: '⚙️', description: 'Domain-specific technical depth — knowledge, problem-solving, trends, and practical application.' },
  { slug: 'case-study', label: 'Case Study Round', icon: '📋', description: 'Scenario-based problem-solving — structured thinking, frameworks, and business reasoning.' },
  { slug: 'system-design', label: 'System Design Round', icon: '🏗️', description: 'Architecture and system design — scalability, trade-offs, component design, and technical breadth.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet', 'devops'] },
  { slug: 'coding', label: 'Coding Round', icon: '💻', description: 'Live coding problem-solving — algorithm design, implementation, testing, and optimization.', applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'] },
]
