// ─── Domain-specific interview prep tips ─────────────────────────────────────

export interface PrepTip {
  text: string
  icon: 'star' | 'chart' | 'users' | 'code' | 'bulb'
}

export const GENERAL_TIPS: PrepTip[] = [
  { text: 'Have 3 STAR stories ready (Situation, Task, Action, Result)', icon: 'star' },
  { text: 'Review your resume — be ready to discuss anything on it', icon: 'chart' },
  { text: "Know why you want this role and what excites you about it", icon: 'bulb' },
]

const DOMAIN_TIPS: Record<string, PrepTip[]> = {
  // Product & Design
  pm: [
    { text: 'Prepare a metrics framework (e.g., HEART, NSM, AARRR)', icon: 'chart' },
    { text: 'Have a product teardown ready for a product you use daily', icon: 'bulb' },
    { text: 'Practice explaining trade-offs between user needs and business goals', icon: 'users' },
  ],
  design: [
    { text: 'Walk through a case study end-to-end (problem, research, iterations, outcome)', icon: 'bulb' },
    { text: 'Prepare to discuss a design decision where you had to compromise', icon: 'users' },
    { text: 'Know your design process and how you handle ambiguity', icon: 'star' },
  ],
  // Engineering
  frontend: [
    { text: 'Have a UI architecture example ready (component design, state management)', icon: 'code' },
    { text: 'Prepare to discuss web performance optimization with measurable impact', icon: 'bulb' },
    { text: 'Review your experience with accessibility and responsive design', icon: 'star' },
  ],
  backend: [
    { text: 'Have a system design example ready (scale, trade-offs, decisions)', icon: 'code' },
    { text: 'Prepare to discuss a debugging war story with measurable impact', icon: 'bulb' },
    { text: 'Review your most impactful technical contribution in detail', icon: 'star' },
  ],
  sdet: [
    { text: 'Prepare a test strategy example — what to automate vs. test manually', icon: 'code' },
    { text: 'Have examples of CI/CD testing pipelines you designed or improved', icon: 'chart' },
    { text: 'Know your approach to balancing test coverage with development velocity', icon: 'bulb' },
  ],
  'data-science': [
    { text: 'Prepare to explain a model you built — from problem framing to deployment', icon: 'code' },
    { text: 'Know your go-to approach for A/B testing and statistical significance', icon: 'chart' },
    { text: 'Have an example of communicating technical findings to non-technical stakeholders', icon: 'users' },
  ],
  // Business
  business: [
    { text: 'Practice structuring answers using frameworks (MECE, Issue Trees)', icon: 'chart' },
    { text: 'Prepare your leadership philosophy with concrete examples', icon: 'star' },
    { text: 'Have examples of stakeholder management and influence without authority', icon: 'users' },
  ],
  general: [
    { text: 'Prepare 3-5 strong STAR stories covering leadership, conflict, and growth', icon: 'star' },
    { text: 'Practice your "tell me about yourself" — concise, compelling, and role-relevant', icon: 'users' },
    { text: 'Know your strengths and weaknesses with honest self-reflection', icon: 'bulb' },
  ],
  // Legacy slug mappings (backward compat with existing sessions)
  PM: [
    { text: 'Prepare a metrics framework (e.g., HEART, NSM, AARRR)', icon: 'chart' },
    { text: 'Have a product teardown ready for a product you use daily', icon: 'bulb' },
    { text: 'Practice explaining trade-offs between user needs and business goals', icon: 'users' },
  ],
  SWE: [
    { text: 'Have a system design example ready (scale, trade-offs, decisions)', icon: 'code' },
    { text: 'Prepare to discuss a debugging war story with measurable impact', icon: 'bulb' },
    { text: 'Review your most impactful technical contribution in detail', icon: 'star' },
  ],
  Sales: [
    { text: 'Know your top 3 deals — pipeline, objections handled, and close strategy', icon: 'chart' },
    { text: 'Prepare your 60-second elevator pitch', icon: 'star' },
    { text: 'Have examples of relationship building and consultative selling', icon: 'users' },
  ],
  MBA: [
    { text: 'Practice structuring answers using frameworks (MECE, Issue Trees)', icon: 'chart' },
    { text: 'Prepare your leadership philosophy with concrete examples', icon: 'star' },
    { text: 'Have examples of stakeholder management and influence without authority', icon: 'users' },
  ],
}

export function getDomainTips(domainSlug: string): PrepTip[] {
  return DOMAIN_TIPS[domainSlug] || GENERAL_TIPS
}

// ─── Checklist sections ──────────────────────────────────────────────────────

export interface ChecklistSection {
  id: string
  title: string
  icon: string
  items: string[]
}

export const CHECKLIST_SECTIONS: ChecklistSection[] = [
  {
    id: 'environment',
    title: 'Environment',
    icon: '🏠',
    items: [
      'Find a quiet room with minimal background noise',
      'Check your lighting — face a window or lamp, not away from it',
      'Use a neutral, uncluttered background',
    ],
  },
  {
    id: 'tech',
    title: 'Technology',
    icon: '💻',
    items: [
      'Use a stable internet connection (wired is best)',
      'Wear headphones to prevent echo',
      'Close other browser tabs and apps to reduce lag',
    ],
  },
  {
    id: 'content',
    title: 'Content Prep',
    icon: '📋',
    items: [
      'Review the job description for key requirements',
      'Prepare 3 STAR stories covering leadership, challenge, and impact',
      'Know your resume highlights — be ready to discuss any claim',
    ],
  },
  {
    id: 'mindset',
    title: 'Mindset',
    icon: '🧠',
    items: [
      'Treat this as practice — mistakes are learning opportunities',
      'Take a deep breath before each answer',
      'Pause 1-2 seconds before responding to collect your thoughts',
    ],
  },
]

// ─── Warm-up questions ───────────────────────────────────────────────────────

export const WARMUP_QUESTIONS: string[] = [
  'Tell me about yourself and your professional background in 60 seconds.',
  'What are you most proud of in your career so far?',
  'Describe a recent challenge you overcame at work.',
  'What motivates you to come to work every day?',
  'Tell me about a time you had to learn something new quickly.',
  'What is your biggest professional achievement in the last year?',
  'Describe your ideal work environment.',
  'How do you handle disagreements with colleagues?',
  'What is one skill you are actively working to improve?',
  'Tell me about a project where you exceeded expectations.',
]
