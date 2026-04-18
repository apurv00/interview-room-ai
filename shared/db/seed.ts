import { connectDB } from './connection'
import { InterviewDomain } from './models/InterviewDomain'
import { InterviewDepth } from './models/InterviewDepth'

const BUILT_IN_DOMAINS = [
  // ─── General ───────────────────────────────────────────────────────────────
  {
    slug: 'general', label: 'General / Any Role', shortLabel: 'GEN', icon: '🎯', category: 'general' as const, sortOrder: 0,
    description: 'General interview practice — problem-solving, communication, leadership, teamwork, and adaptability.',
    systemPromptContext: 'The candidate wants general interview practice without a specific role focus. Ask versatile questions applicable across roles. Focus on universal competencies: problem-solving, communication, leadership, teamwork, adaptability, and growth mindset.',
    sampleQuestions: ['Tell me about a challenging project you led. What was the outcome?', 'Describe a time you had to learn something new quickly.'],
    evaluationEmphasis: ['communication', 'problem_solving', 'leadership'],
  },
  // ─── Engineering ────────────────────────────────────────────────────────────
  {
    slug: 'frontend', label: 'Frontend Engineer', shortLabel: 'FE', icon: '🖥', category: 'engineering' as const, sortOrder: 1,
    description: 'UI development, React/Angular/Vue, web performance, accessibility, and responsive design.',
    systemPromptContext: 'The candidate is interviewing for a Frontend Engineer role. Probe UI architecture decisions, framework expertise (React, Angular, Vue), web performance optimization, accessibility practices, CSS/design-system fluency, and cross-browser concerns.',
    sampleQuestions: ['Walk me through how you optimized a slow-loading page.', 'How do you approach building accessible components?'],
    evaluationEmphasis: ['technical_depth', 'ui_architecture', 'accessibility'],
  },
  {
    slug: 'backend', label: 'Backend / Infra Engineer', shortLabel: 'BE', icon: '🔧', category: 'engineering' as const, sortOrder: 2,
    description: 'APIs, databases, system design, microservices, scalability, infrastructure, CI/CD, and cloud platforms.',
    systemPromptContext: 'The candidate is interviewing for a Backend/Infrastructure Engineer role. Probe API design, database modeling, system design, microservices architecture, scalability strategies, distributed-systems thinking, infrastructure experience, CI/CD pipeline design, monitoring/observability, incident management, and reliability practices.',
    sampleQuestions: ['Describe a complex system you designed. What tradeoffs did you make?', 'Tell me about a production incident you resolved.', 'Describe your approach to designing a CI/CD pipeline.'],
    evaluationEmphasis: ['technical_depth', 'system_design', 'problem_solving', 'infrastructure_knowledge'],
  },
  {
    slug: 'sdet', label: 'SDET / QA', shortLabel: 'QA', icon: '🧪', category: 'engineering' as const, sortOrder: 3,
    description: 'Test automation, quality strategy, CI/CD testing, performance testing, and reliability.',
    systemPromptContext: 'The candidate is interviewing for an SDET/QA Engineer role. Probe test automation frameworks, quality strategy, CI/CD integration, performance/load testing, and their approach to balancing test coverage with development velocity.',
    sampleQuestions: ['How do you decide what to automate vs. test manually?', 'Describe a test strategy you designed for a complex feature.'],
    evaluationEmphasis: ['test_strategy', 'automation_depth', 'quality_mindset'],
  },
  {
    slug: 'data-science', label: 'Data Science / ML', shortLabel: 'DS', icon: '📊', category: 'engineering' as const, sortOrder: 4,
    description: 'ML models, statistics, experimentation, data storytelling, and business impact.',
    systemPromptContext: 'The candidate is interviewing for a Data Science role. Probe statistical knowledge, ML model building, experiment design (A/B testing), data storytelling, and translating insights to business impact.',
    sampleQuestions: ['Describe an ML model you built that impacted a business metric.', 'How do you design an A/B test?'],
    evaluationEmphasis: ['statistical_knowledge', 'ml_depth', 'business_impact'],
  },
  // ─── Product & Design ──────────────────────────────────────────────────────
  {
    slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', category: 'product' as const, sortOrder: 5,
    description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.',
    systemPromptContext: 'The candidate is interviewing for a Product Manager role. Probe product sense, prioritization frameworks, stakeholder management, metrics-driven thinking, and user empathy.',
    sampleQuestions: ['Tell me about a product you launched from 0 to 1.', 'How do you prioritize features with competing stakeholder demands?'],
    evaluationEmphasis: ['product_sense', 'prioritization', 'metrics_thinking'],
  },
  {
    slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', category: 'product' as const, sortOrder: 6,
    description: 'User research, design thinking, prototyping, and design system expertise.',
    systemPromptContext: 'The candidate is interviewing for a Design/UX role. Probe user research methodology, design thinking process, prototyping skills, accessibility awareness, and collaboration with engineering.',
    sampleQuestions: ['Walk me through your design process for a recent project.', 'How do you handle conflicting feedback from users and stakeholders?'],
    evaluationEmphasis: ['design_thinking', 'user_empathy', 'craft'],
  },
  // ─── Business ──────────────────────────────────────────────────────────────
  {
    slug: 'business', label: 'Business & Strategy', shortLabel: 'BIZ', icon: '🎓', category: 'business' as const, sortOrder: 7,
    description: 'Strategy, consulting, finance, marketing, sales, leadership, and cross-functional impact.',
    systemPromptContext: 'The candidate is interviewing for a Business/Strategy role. Probe strategic thinking, problem structuring, framework application, leadership, analytical skills, client/stakeholder management, executive communication, campaign strategy, financial modeling, risk assessment, deal management, and revenue growth.',
    sampleQuestions: ['Tell me about a time you influenced strategy without direct authority.', 'How would you structure an analysis for a client entering a new market?', 'Describe a campaign or deal you led that exceeded expectations.'],
    evaluationEmphasis: ['strategic_thinking', 'structured_thinking', 'leadership', 'analytical_rigor'],
  },
]

const BUILT_IN_DEPTHS = [
  {
    slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', sortOrder: 1,
    description: 'Behavioral probing — motivation, leadership, conflict resolution, self-awareness, and culture fit.',
    systemPromptTemplate: 'You are Alex Chen, a senior interviewer conducting a {duration}-minute behavioral interview for a {domain} role ({experience} years experience). Start warm and conversational, then dig deeper into past experiences with multi-layered follow-ups.',
    questionStrategy: 'Start with motivation and culture-fit questions, then probe deeper into leadership scenarios, conflict resolution, failure recovery, team dynamics, and ethical dilemmas. Rotate through: behavioral (STAR), motivation, situational, and consistency checks. Challenge vague answers with follow-ups.',
    evaluationCriteria: 'Evaluate STAR structure, ownership language, specificity of examples, depth of reflection, self-awareness, growth mindset, leadership signal, and cultural fit signals.',
    avatarPersona: 'Warm but thorough interviewer. Starts encouraging and conversational, then digs deep. Asks "tell me more" and "what would you do differently?"',
    scoringDimensions: [
      { name: 'relevance', label: 'Relevance', weight: 0.15 },
      { name: 'structure', label: 'STAR Structure', weight: 0.25 },
      { name: 'specificity', label: 'Specificity', weight: 0.20 },
      { name: 'ownership', label: 'Ownership', weight: 0.20 },
      { name: 'self_awareness', label: 'Self-Awareness', weight: 0.20 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'technical', label: 'Technical Deep Dive', icon: '⚙️', sortOrder: 2,
    description: 'Domain-specific technical depth — knowledge, problem-solving, trends, and practical application.',
    systemPromptTemplate: 'You are Alex Chen, a technical interviewer conducting a {duration}-minute technical interview for a {domain} role ({experience} years experience). Test technical depth, domain knowledge, and problem-solving ability through scenario-based questions.',
    questionStrategy: 'Ask domain-specific technical questions and industry knowledge probes. For engineering: system design, architecture, debugging, tooling. For PM: metrics, estimation, technical tradeoffs. For DS: statistics, ML, experiment design. For business: frameworks, quantitative reasoning. Also test industry trends, best practices, and practical application. Adapt to the domain.',
    evaluationCriteria: 'Evaluate technical accuracy, depth of knowledge, problem-solving approach, awareness of current trends, and ability to communicate technical concepts clearly.',
    avatarPersona: 'Technical interviewer who is collaborative but expects rigor. Engages in professional dialogue about domain expertise.',
    scoringDimensions: [
      { name: 'technical_accuracy', label: 'Technical Accuracy', weight: 0.25 },
      { name: 'depth', label: 'Depth of Knowledge', weight: 0.25 },
      { name: 'problem_solving', label: 'Problem Solving', weight: 0.25 },
      { name: 'communication', label: 'Technical Communication', weight: 0.25 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'case-study', label: 'Case Study', icon: '📋', sortOrder: 3,
    description: 'Scenario-based problem-solving — structured thinking, frameworks, and business reasoning.',
    systemPromptTemplate: 'You are Alex Chen, conducting a {duration}-minute case study interview for a {domain} role ({experience} years experience). Present realistic business or technical scenarios and evaluate the candidate\'s structured approach.',
    questionStrategy: 'Present scenarios relevant to the domain. Guide the candidate through a structured case: clarifying questions → framework → analysis → recommendation. Provide data points when asked. For engineering domains, use system-design or debugging scenarios instead of business cases.',
    evaluationCriteria: 'Evaluate framework usage, structured thinking, ability to ask clarifying questions, quantitative reasoning, and quality of final recommendation.',
    avatarPersona: 'Case interviewer who sets up scenarios and lets the candidate drive. Provides hints when stuck but expects structured thinking.',
    scoringDimensions: [
      { name: 'framework_usage', label: 'Framework Usage', weight: 0.25 },
      { name: 'structured_thinking', label: 'Structured Thinking', weight: 0.25 },
      { name: 'quantitative_reasoning', label: 'Quantitative Reasoning', weight: 0.25 },
      { name: 'recommendation_quality', label: 'Recommendation Quality', weight: 0.25 },
    ],
    applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'],
  },
  {
    slug: 'system-design', label: 'System Design', icon: '🏗️', sortOrder: 4,
    description: 'Architecture and system design — scalability, trade-offs, data modeling, and distributed systems.',
    systemPromptTemplate: 'You are Alex Chen, a senior technical interviewer conducting a {duration}-minute system design interview for a {domain} role ({experience} years experience). Present a system design problem and guide the candidate through requirements gathering, high-level design, deep dives, and trade-off discussions.',
    questionStrategy: 'Present ONE system design problem. Let the candidate drive: requirements clarification → high-level architecture → component deep-dive → scaling discussion → trade-offs. Probe on: data modeling, API design, caching strategy, database selection, consistency vs availability, failure handling, monitoring. Ask "what happens when X fails?" and "how would you scale this 10x?"',
    evaluationCriteria: 'Evaluate ability to clarify requirements, propose sensible architecture, reason about scalability and trade-offs, make justified technology choices, and communicate design decisions clearly.',
    avatarPersona: 'Collaborative senior architect who sets up the problem and lets the candidate lead. Provides constraints when asked and probes on weak areas.',
    scoringDimensions: [
      { name: 'requirements_clarity', label: 'Requirements Gathering', weight: 0.15 },
      { name: 'architecture', label: 'Architecture Design', weight: 0.25 },
      { name: 'scalability', label: 'Scalability Reasoning', weight: 0.25 },
      { name: 'tradeoffs', label: 'Trade-off Analysis', weight: 0.20 },
      { name: 'communication', label: 'Design Communication', weight: 0.15 },
    ],
    applicableDomains: ['backend', 'frontend', 'sdet', 'data-science', 'general'],
  },
  {
    slug: 'coding', label: 'Coding Challenge', icon: '💻', sortOrder: 5,
    description: 'Live coding problem-solving — algorithm design, implementation, testing, and optimization.',
    systemPromptTemplate: 'You are Alex Chen, a senior technical interviewer conducting a {duration}-minute coding interview for a {domain} role ({experience} years experience). Present a coding problem, let the candidate ask clarifying questions, then evaluate their code solution.',
    questionStrategy: 'Present ONE coding problem at a time. Let the candidate clarify requirements, discuss approach, implement the solution, and explain trade-offs. Ask about time/space complexity. Ask "what edge cases should we handle?" and "how would you optimize this?"',
    evaluationCriteria: 'Evaluate correctness (does it work for all cases), code quality (readability, naming, structure), algorithmic efficiency (time/space complexity), edge case handling, and ability to communicate their approach clearly.',
    avatarPersona: 'Collaborative technical interviewer who sets up the problem and lets the candidate drive. Provides hints on syntax but probes on algorithmic thinking and trade-offs.',
    scoringDimensions: [
      { name: 'correctness', label: 'Correctness', weight: 0.30 },
      { name: 'efficiency', label: 'Efficiency (Time/Space)', weight: 0.25 },
      { name: 'code_quality', label: 'Code Quality & Style', weight: 0.20 },
      { name: 'communication', label: 'Communication', weight: 0.15 },
      { name: 'edge_cases', label: 'Edge Cases & Testing', weight: 0.10 },
    ],
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
  },
]

export async function seedDatabase() {
  await connectDB()

  const currentDomainSlugs = BUILT_IN_DOMAINS.map(d => d.slug)
  const currentDepthSlugs = BUILT_IN_DEPTHS.map(d => d.slug)

  // Upsert domains
  for (const domain of BUILT_IN_DOMAINS) {
    await InterviewDomain.findOneAndUpdate(
      { slug: domain.slug },
      { ...domain, isBuiltIn: true, isActive: true },
      { upsert: true, returnDocument: 'after' }
    )
  }

  // Deactivate old built-in domains no longer in the list
  await InterviewDomain.updateMany(
    { isBuiltIn: true, slug: { $nin: currentDomainSlugs } },
    { isActive: false }
  )

  // Upsert depths
  for (const depth of BUILT_IN_DEPTHS) {
    await InterviewDepth.findOneAndUpdate(
      { slug: depth.slug },
      { ...depth, isBuiltIn: true, isActive: true },
      { upsert: true, returnDocument: 'after' }
    )
  }

  // Deactivate old built-in depths no longer in the list
  await InterviewDepth.updateMany(
    { isBuiltIn: true, slug: { $nin: currentDepthSlugs } },
    { isActive: false }
  )

  return { domains: BUILT_IN_DOMAINS.length, depths: BUILT_IN_DEPTHS.length }
}

// Fallback data for when DB is not available (used by public APIs)
export const FALLBACK_DOMAINS = BUILT_IN_DOMAINS.map(d => ({
  slug: d.slug,
  label: d.label,
  shortLabel: d.shortLabel,
  icon: d.icon,
  description: d.description,
  color: 'indigo',
  category: d.category,
  systemPromptContext: d.systemPromptContext,
}))

export const FALLBACK_DEPTHS = BUILT_IN_DEPTHS.map(d => ({
  slug: d.slug,
  label: d.label,
  icon: d.icon,
  description: d.description,
  scoringDimensions: d.scoringDimensions,
  systemPromptTemplate: d.systemPromptTemplate,
  questionStrategy: d.questionStrategy,
  evaluationCriteria: d.evaluationCriteria,
  avatarPersona: d.avatarPersona,
  applicableDomains: d.applicableDomains as string[],
}))
