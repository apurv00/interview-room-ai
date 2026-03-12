import { connectDB } from './connection'
import { InterviewDomain } from './models/InterviewDomain'
import { InterviewDepth } from './models/InterviewDepth'

const BUILT_IN_DOMAINS = [
  {
    slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', category: 'business' as const, sortOrder: 1,
    description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.',
    systemPromptContext: 'The candidate is interviewing for a Product Manager role. Probe product sense, prioritization frameworks, stakeholder management, metrics-driven thinking, and user empathy.',
    sampleQuestions: ['Tell me about a product you launched from 0 to 1.', 'How do you prioritize features with competing stakeholder demands?'],
    evaluationEmphasis: ['product_sense', 'prioritization', 'metrics_thinking'],
  },
  {
    slug: 'swe', label: 'Software Engineer', shortLabel: 'SWE', icon: '💻', category: 'engineering' as const, sortOrder: 2,
    description: 'System design, coding practices, debugging, collaboration, and technical leadership.',
    systemPromptContext: 'The candidate is interviewing for a Software Engineer role. Probe system design thinking, coding practices, debugging approach, collaboration skills, and technical decision-making.',
    sampleQuestions: ['Describe a complex system you designed. What tradeoffs did you make?', 'Tell me about a production incident you resolved.'],
    evaluationEmphasis: ['technical_depth', 'problem_solving', 'collaboration'],
  },
  {
    slug: 'sales', label: 'Sales', shortLabel: 'Sales', icon: '📈', category: 'business' as const, sortOrder: 3,
    description: 'Pipeline management, deal closing, relationship building, and revenue growth.',
    systemPromptContext: 'The candidate is interviewing for a Sales role. Probe pipeline management, deal-closing strategies, objection handling, relationship building, and revenue achievement.',
    sampleQuestions: ['Walk me through your biggest deal. How did you close it?', 'How do you handle a prospect who goes silent?'],
    evaluationEmphasis: ['persuasion', 'metrics_driven', 'resilience'],
  },
  {
    slug: 'mba', label: 'MBA / Business', shortLabel: 'MBA', icon: '🎓', category: 'business' as const, sortOrder: 4,
    description: 'Business strategy, leadership, analytical thinking, and cross-functional impact.',
    systemPromptContext: 'The candidate is interviewing for a general business/MBA role. Probe strategic thinking, leadership experiences, analytical skills, and cross-functional impact.',
    sampleQuestions: ['Tell me about a time you influenced strategy without direct authority.', 'Describe a data-driven decision you made.'],
    evaluationEmphasis: ['strategic_thinking', 'leadership', 'analytical_skills'],
  },
  {
    slug: 'data-science', label: 'Data Scientist', shortLabel: 'DS', icon: '📊', category: 'engineering' as const, sortOrder: 5,
    description: 'Statistical modeling, ML pipelines, data storytelling, and business impact.',
    systemPromptContext: 'The candidate is interviewing for a Data Science role. Probe statistical knowledge, ML model building, experiment design (A/B testing), data storytelling, and translating insights to business impact.',
    sampleQuestions: ['Describe an ML model you built that impacted a business metric.', 'How do you design an A/B test?'],
    evaluationEmphasis: ['statistical_knowledge', 'ml_depth', 'business_impact'],
  },
  {
    slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', category: 'design' as const, sortOrder: 6,
    description: 'User research, design thinking, prototyping, and design system expertise.',
    systemPromptContext: 'The candidate is interviewing for a Design/UX role. Probe user research methodology, design thinking process, prototyping skills, accessibility awareness, and collaboration with engineering.',
    sampleQuestions: ['Walk me through your design process for a recent project.', 'How do you handle conflicting feedback from users and stakeholders?'],
    evaluationEmphasis: ['design_thinking', 'user_empathy', 'craft'],
  },
  {
    slug: 'marketing', label: 'Marketing', shortLabel: 'MKT', icon: '📣', category: 'business' as const, sortOrder: 7,
    description: 'Growth strategies, campaign management, brand building, and analytics.',
    systemPromptContext: 'The candidate is interviewing for a Marketing role. Probe campaign strategy, growth marketing, brand positioning, analytics-driven optimization, and cross-channel experience.',
    sampleQuestions: ['Tell me about a campaign that exceeded its goals. What made it work?', 'How do you measure marketing ROI?'],
    evaluationEmphasis: ['creative_strategy', 'data_driven', 'brand_thinking'],
  },
  {
    slug: 'finance', label: 'Finance', shortLabel: 'FIN', icon: '💰', category: 'business' as const, sortOrder: 8,
    description: 'Financial modeling, risk assessment, strategic planning, and regulatory compliance.',
    systemPromptContext: 'The candidate is interviewing for a Finance role. Probe financial modeling skills, risk assessment, strategic financial planning, and regulatory/compliance awareness.',
    sampleQuestions: ['Describe a financial model you built that informed a strategic decision.', 'How do you assess risk in a new market entry?'],
    evaluationEmphasis: ['analytical_rigor', 'risk_assessment', 'strategic_thinking'],
  },
  {
    slug: 'consulting', label: 'Consulting', shortLabel: 'CON', icon: '🧩', category: 'business' as const, sortOrder: 9,
    description: 'Problem structuring, client management, frameworks, and executive communication.',
    systemPromptContext: 'The candidate is interviewing for a Consulting role. Probe problem structuring ability, framework application, client management, executive communication, and ability to drive recommendations.',
    sampleQuestions: ['How would you structure an analysis for a client entering a new market?', 'Tell me about a time you delivered a difficult recommendation to a client.'],
    evaluationEmphasis: ['structured_thinking', 'client_management', 'communication'],
  },
  {
    slug: 'devops', label: 'DevOps / SRE', shortLabel: 'SRE', icon: '⚙️', category: 'engineering' as const, sortOrder: 10,
    description: 'Infrastructure, CI/CD, reliability engineering, and incident management.',
    systemPromptContext: 'The candidate is interviewing for a DevOps/SRE role. Probe infrastructure experience, CI/CD pipeline design, monitoring/observability, incident management, and reliability practices.',
    sampleQuestions: ['Describe your approach to designing a CI/CD pipeline.', 'Tell me about a major incident you managed. What was your role?'],
    evaluationEmphasis: ['infrastructure_knowledge', 'reliability_thinking', 'incident_management'],
  },
  {
    slug: 'hr', label: 'Human Resources', shortLabel: 'HR', icon: '🤝', category: 'operations' as const, sortOrder: 11,
    description: 'Talent acquisition, employee relations, organizational development, and compliance.',
    systemPromptContext: 'The candidate is interviewing for an HR role. Probe talent acquisition strategy, employee relations handling, organizational development initiatives, and compliance/policy knowledge.',
    sampleQuestions: ['How do you handle a conflict between a manager and their report?', 'Describe a talent strategy you implemented.'],
    evaluationEmphasis: ['people_skills', 'conflict_resolution', 'organizational_awareness'],
  },
  {
    slug: 'legal', label: 'Legal', shortLabel: 'LGL', icon: '⚖️', category: 'operations' as const, sortOrder: 12,
    description: 'Contract negotiation, regulatory compliance, risk management, and legal strategy.',
    systemPromptContext: 'The candidate is interviewing for a Legal role. Probe contract negotiation experience, regulatory compliance knowledge, risk management approach, and ability to translate legal concepts for business stakeholders.',
    sampleQuestions: ['Tell me about a complex negotiation you led.', 'How do you balance legal risk with business speed?'],
    evaluationEmphasis: ['legal_knowledge', 'negotiation', 'business_acumen'],
  },
]

const BUILT_IN_DEPTHS = [
  {
    slug: 'hr-screening', label: 'HR Screening', icon: '🤝', sortOrder: 1,
    description: 'Standard behavioral screening — motivation, culture fit, and communication skills.',
    systemPromptTemplate: 'You are Alex Chen, a senior HR interviewer conducting a {duration}-minute behavioral screening for a {domain} role ({experience} years experience). Your style is warm but professional. You ask ONE focused question at a time.',
    questionStrategy: 'Rotate through: behavioral (STAR), motivation, situational, consistency check. Keep questions conversational and natural.',
    evaluationCriteria: 'Focus on STAR structure, ownership language, specificity of examples, and cultural fit signals.',
    avatarPersona: 'Warm, professional HR interviewer. Encouraging but probing.',
    scoringDimensions: [
      { name: 'relevance', label: 'Relevance', weight: 0.25 },
      { name: 'structure', label: 'STAR Structure', weight: 0.25 },
      { name: 'specificity', label: 'Specificity', weight: 0.25 },
      { name: 'ownership', label: 'Ownership', weight: 0.25 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'behavioral', label: 'Behavioral Deep Dive', icon: '🧠', sortOrder: 2,
    description: 'In-depth behavioral probing — leadership, conflict resolution, teamwork, and decision-making.',
    systemPromptTemplate: 'You are Alex Chen, a senior interviewer conducting a {duration}-minute deep behavioral interview for a {domain} role ({experience} years experience). Dig deep into past experiences with multi-layered follow-ups.',
    questionStrategy: 'Focus on leadership scenarios, conflict resolution, failure recovery, team dynamics, and ethical dilemmas. Use follow-up questions aggressively to get to the root of stories. Challenge vague answers.',
    evaluationCriteria: 'Evaluate depth of reflection, self-awareness, growth mindset, leadership signal, and ability to articulate lessons learned.',
    avatarPersona: 'Thoughtful, curious interviewer who digs deep. Asks "tell me more" and "what would you do differently?"',
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
    slug: 'technical', label: 'Technical Interview', icon: '⚙️', sortOrder: 3,
    description: 'Domain-specific technical questions — depth of knowledge, problem-solving, and technical communication.',
    systemPromptTemplate: 'You are Alex Chen, a technical interviewer conducting a {duration}-minute technical screen for a {domain} role ({experience} years experience). Test technical depth and problem-solving ability through scenario-based questions.',
    questionStrategy: 'Ask domain-specific technical questions. For SWE: system design, architecture decisions, debugging. For PM: metrics, estimation, technical tradeoffs. For DS: statistics, ML concepts, experiment design. Adapt to the domain.',
    evaluationCriteria: 'Evaluate technical accuracy, depth of knowledge, problem-solving approach, and ability to communicate technical concepts clearly.',
    avatarPersona: 'Technical interviewer who is collaborative but expects rigor. Asks clarifying questions and probes technical depth.',
    scoringDimensions: [
      { name: 'technical_accuracy', label: 'Technical Accuracy', weight: 0.30 },
      { name: 'depth', label: 'Depth of Knowledge', weight: 0.25 },
      { name: 'problem_solving', label: 'Problem Solving', weight: 0.25 },
      { name: 'communication', label: 'Technical Communication', weight: 0.20 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'case-study', label: 'Case Study', icon: '📋', sortOrder: 4,
    description: 'Situational business cases — structured thinking, frameworks, and creative problem-solving.',
    systemPromptTemplate: 'You are Alex Chen, conducting a {duration}-minute case study interview for a {domain} role ({experience} years experience). Present realistic business scenarios and evaluate the candidate\'s structured approach.',
    questionStrategy: 'Present business scenarios relevant to the domain. Guide the candidate through a structured case: clarifying questions → framework → analysis → recommendation. Provide data points when asked.',
    evaluationCriteria: 'Evaluate framework usage, structured thinking, ability to ask clarifying questions, quantitative reasoning, and quality of final recommendation.',
    avatarPersona: 'Case interviewer who sets up scenarios and lets the candidate drive. Provides hints when stuck but expects structured thinking.',
    scoringDimensions: [
      { name: 'framework_usage', label: 'Framework Usage', weight: 0.25 },
      { name: 'structured_thinking', label: 'Structured Thinking', weight: 0.25 },
      { name: 'quantitative_reasoning', label: 'Quantitative Reasoning', weight: 0.25 },
      { name: 'recommendation_quality', label: 'Recommendation Quality', weight: 0.25 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'domain-knowledge', label: 'Domain Knowledge', icon: '📚', sortOrder: 5,
    description: 'Industry and function-specific knowledge probing — trends, best practices, and practical application.',
    systemPromptTemplate: 'You are Alex Chen, conducting a {duration}-minute domain knowledge assessment for a {domain} role ({experience} years experience). Test industry awareness, functional expertise, and ability to apply knowledge practically.',
    questionStrategy: 'Ask about industry trends, best practices, tools of the trade, and practical scenarios. Test both breadth and depth of domain knowledge. Include questions about emerging trends and how the candidate stays current.',
    evaluationCriteria: 'Evaluate breadth of knowledge, depth in key areas, practical application ability, awareness of current trends, and ability to form opinions backed by evidence.',
    avatarPersona: 'Subject-matter expert interviewer who is genuinely curious about the candidate\'s domain expertise. Engages in professional dialogue.',
    scoringDimensions: [
      { name: 'knowledge_breadth', label: 'Knowledge Breadth', weight: 0.20 },
      { name: 'knowledge_depth', label: 'Knowledge Depth', weight: 0.30 },
      { name: 'practical_application', label: 'Practical Application', weight: 0.30 },
      { name: 'trend_awareness', label: 'Trend Awareness', weight: 0.20 },
    ],
    applicableDomains: [],
  },
  {
    slug: 'culture-fit', label: 'Culture Fit', icon: '🌱', sortOrder: 6,
    description: 'Values alignment, work style, team dynamics, and organizational culture match.',
    systemPromptTemplate: 'You are Alex Chen, conducting a {duration}-minute culture fit interview for a {domain} role ({experience} years experience). Explore values, work style, collaboration preferences, and what drives the candidate.',
    questionStrategy: 'Ask about work environment preferences, collaboration style, handling disagreements, what motivates them, deal-breakers, and how they contribute to team culture. Keep it conversational and authentic.',
    evaluationCriteria: 'Evaluate authenticity, self-awareness, alignment with collaborative work culture, growth mindset, and ability to articulate values.',
    avatarPersona: 'Friendly, authentic interviewer who creates a safe space for honest conversation. More conversational than formal.',
    scoringDimensions: [
      { name: 'authenticity', label: 'Authenticity', weight: 0.25 },
      { name: 'self_awareness', label: 'Self-Awareness', weight: 0.25 },
      { name: 'values_alignment', label: 'Values Alignment', weight: 0.25 },
      { name: 'growth_mindset', label: 'Growth Mindset', weight: 0.25 },
    ],
    applicableDomains: [],
  },
]

export async function seedDatabase() {
  await connectDB()

  // Upsert domains
  for (const domain of BUILT_IN_DOMAINS) {
    await InterviewDomain.findOneAndUpdate(
      { slug: domain.slug },
      { ...domain, isBuiltIn: true },
      { upsert: true, new: true }
    )
  }

  // Upsert depths
  for (const depth of BUILT_IN_DEPTHS) {
    await InterviewDepth.findOneAndUpdate(
      { slug: depth.slug },
      { ...depth, isBuiltIn: true },
      { upsert: true, new: true }
    )
  }

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
