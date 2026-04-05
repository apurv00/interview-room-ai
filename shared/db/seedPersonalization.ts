import { connectDB } from './connection'
import { EvaluationRubric } from './models/EvaluationRubric'
import { QuestionBank } from './models/QuestionBank'
import { CompanyPattern } from './models/CompanyPattern'
import { BenchmarkCase } from './models/BenchmarkCase'

// ─── Built-in Evaluation Rubrics ────────────────────────────────────────────

const BUILT_IN_RUBRICS = [
  {
    rubricId: 'rubric_universal_hr_v1',
    domain: '*',
    interviewType: 'behavioral',
    seniorityBand: '*',
    version: 1,
    passThreshold: 60,
    strongPassThreshold: 80,
    competencies: ['relevance', 'structure', 'specificity', 'ownership', 'communication'],
    dimensions: [
      {
        name: 'relevance', label: 'Relevance', weight: 0.25,
        description: 'Does the answer directly address the question asked?',
        scoringGuide: {
          excellent: 'Directly addresses question with clear focus, no tangents',
          good: 'Mostly on topic with minor tangents',
          adequate: 'Partially addresses the question, some drift',
          weak: 'Off-topic or fails to answer the question',
        },
      },
      {
        name: 'structure', label: 'STAR Structure', weight: 0.25,
        description: 'Does the answer follow Situation-Task-Action-Result format?',
        scoringGuide: {
          excellent: 'Clear STAR structure with all components present and well-articulated',
          good: 'Mostly structured, may miss one STAR component',
          adequate: 'Some structure but missing multiple components',
          weak: 'No discernible structure, stream-of-consciousness',
        },
      },
      {
        name: 'specificity', label: 'Specificity', weight: 0.25,
        description: 'Are there concrete details, metrics, and examples?',
        scoringGuide: {
          excellent: 'Multiple specific metrics, named tools/methods, concrete outcomes',
          good: 'Some specific details and at least one metric or concrete outcome',
          adequate: 'Generic descriptions with few specifics',
          weak: 'Entirely vague, no concrete details or examples',
        },
      },
      {
        name: 'ownership', label: 'Ownership', weight: 0.25,
        description: 'Does the candidate show personal responsibility and agency?',
        scoringGuide: {
          excellent: 'Strong first-person language, clear personal contribution and decision-making',
          good: 'Mostly shows ownership, occasional "we" without distinguishing personal contribution',
          adequate: 'Mixed ownership, frequently uses "we" without clarity on individual role',
          weak: 'No ownership language, blame-shifts or hides behind team',
        },
      },
    ],
  },
  {
    rubricId: 'rubric_pm_hm_mid_v1',
    domain: 'pm',
    interviewType: 'behavioral',
    seniorityBand: '3-6',
    version: 1,
    passThreshold: 60,
    strongPassThreshold: 78,
    competencies: ['product_sense', 'execution', 'metrics_thinking', 'stakeholder_management', 'tradeoff_reasoning'],
    dimensions: [
      {
        name: 'product_sense', label: 'Product Sense', weight: 0.25,
        description: 'Understanding of user needs, market, and product strategy',
        scoringGuide: {
          excellent: 'Deep user empathy, market awareness, and strategic product thinking',
          good: 'Good product instincts with some strategic reasoning',
          adequate: 'Basic product understanding, limited strategic depth',
          weak: 'No product sense demonstrated',
        },
      },
      {
        name: 'metrics_thinking', label: 'Metrics Thinking', weight: 0.25,
        description: 'Data-driven decision making with specific metrics',
        scoringGuide: {
          excellent: 'Named specific metrics, explained measurement approach, data-driven reasoning',
          good: 'Referenced metrics but could be more specific',
          adequate: 'Vague reference to data without specific metrics',
          weak: 'No metrics or data-driven thinking',
        },
      },
      {
        name: 'execution', label: 'Execution', weight: 0.25,
        description: 'Ability to drive projects from idea to delivery',
        scoringGuide: {
          excellent: 'Clear execution story with timelines, milestones, and outcomes',
          good: 'Shows execution ability but missing some details',
          adequate: 'Mentions execution but lacks concrete process',
          weak: 'No evidence of execution or delivery capability',
        },
      },
      {
        name: 'stakeholder_management', label: 'Stakeholder Management', weight: 0.25,
        description: 'Navigating competing interests and building alignment',
        scoringGuide: {
          excellent: 'Specific examples of alignment-building across competing interests',
          good: 'Shows stakeholder awareness with some specific examples',
          adequate: 'Acknowledges stakeholders but limited depth',
          weak: 'No stakeholder management awareness',
        },
      },
    ],
  },
  {
    rubricId: 'rubric_swe_technical_v1',
    domain: 'backend',
    interviewType: 'technical',
    seniorityBand: '*',
    version: 1,
    passThreshold: 60,
    strongPassThreshold: 80,
    competencies: ['technical_accuracy', 'system_design', 'problem_solving', 'code_quality', 'collaboration'],
    dimensions: [
      {
        name: 'technical_accuracy', label: 'Technical Accuracy', weight: 0.30,
        description: 'Correctness of technical statements and solutions',
        scoringGuide: {
          excellent: 'All technical claims correct, demonstrates deep expertise',
          good: 'Mostly correct with minor inaccuracies',
          adequate: 'Some correct concepts but notable gaps',
          weak: 'Significant technical inaccuracies',
        },
      },
      {
        name: 'depth', label: 'Depth of Knowledge', weight: 0.25,
        description: 'How deeply the candidate understands the topic',
        scoringGuide: {
          excellent: 'Can discuss tradeoffs, edge cases, and alternatives at depth',
          good: 'Good depth on main concepts',
          adequate: 'Surface-level knowledge',
          weak: 'Superficial or incorrect understanding',
        },
      },
      {
        name: 'problem_solving', label: 'Problem Solving', weight: 0.25,
        description: 'Approach to breaking down and solving problems',
        scoringGuide: {
          excellent: 'Systematic approach, considers multiple solutions, clear tradeoff analysis',
          good: 'Reasonable approach with some consideration of alternatives',
          adequate: 'Basic problem-solving but limited analysis',
          weak: 'No structured approach to problem-solving',
        },
      },
      {
        name: 'communication', label: 'Technical Communication', weight: 0.20,
        description: 'Ability to explain technical concepts clearly',
        scoringGuide: {
          excellent: 'Crystal clear explanations, appropriate abstraction level',
          good: 'Generally clear, may be overly technical at times',
          adequate: 'Somewhat unclear explanations',
          weak: 'Cannot articulate technical concepts clearly',
        },
      },
    ],
  },
]

// ─── Built-in Question Bank ─────────────────────────────────────────────────

const BUILT_IN_QUESTIONS = [
  // PM Questions
  {
    domain: 'pm', interviewType: 'behavioral', seniorityBand: '*',
    question: 'Tell me about a time you had to make a difficult product decision with incomplete data.',
    category: 'behavioral', targetCompetencies: ['product_sense', 'metrics_thinking'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Describes the situation and constraints', 'Explains reasoning process', 'Mentions what data they did use', 'Describes outcome and learnings'],
    commonMistakes: ['Too vague about the decision', 'No mention of data or reasoning process'],
    tags: ['decision-making', 'data-driven', 'ambiguity'],
  },
  {
    domain: 'pm', interviewType: 'behavioral', seniorityBand: '3-6',
    question: 'Describe a time you had to align multiple stakeholders with conflicting priorities on a product feature.',
    category: 'behavioral', targetCompetencies: ['stakeholder_management', 'execution'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Names specific stakeholders', 'Describes the conflict clearly', 'Explains alignment strategy', 'Shows measurable outcome'],
    commonMistakes: ['Generic team collaboration story', 'No specific conflict or resolution'],
    tags: ['stakeholder-management', 'conflict-resolution', 'alignment'],
  },
  {
    domain: 'pm', interviewType: 'behavioral', seniorityBand: '*',
    question: 'How do you decide what NOT to build?',
    category: 'situational', targetCompetencies: ['prioritization', 'product_sense', 'tradeoff_reasoning'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Mentions a framework (RICE, ICE, etc.)', 'Discusses user impact', 'Mentions data/evidence', 'Shows willingness to kill features'],
    commonMistakes: ['Only mentions one factor', 'No framework or structured thinking'],
    tags: ['prioritization', 'framework', 'strategy'],
  },
  // SWE Questions
  {
    domain: 'backend', interviewType: 'behavioral', seniorityBand: '*',
    question: 'Tell me about a production incident you resolved. Walk me through your debugging process.',
    category: 'behavioral', targetCompetencies: ['problem_solving', 'technical_accuracy', 'collaboration'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Describes the incident clearly', 'Shows systematic debugging approach', 'Mentions collaboration and communication', 'Discusses prevention measures'],
    commonMistakes: ['Jumps to solution without explaining process', 'No mention of impact or timeline'],
    tags: ['debugging', 'incident-response', 'production'],
  },
  {
    domain: 'backend', interviewType: 'technical', seniorityBand: '7+',
    question: 'Describe a system you designed from scratch. What were the key architectural decisions and tradeoffs?',
    category: 'behavioral', targetCompetencies: ['system_design', 'technical_accuracy', 'depth'],
    difficulty: 'hard' as const,
    idealAnswerPoints: ['Clear architecture overview', 'Specific tradeoffs with reasoning', 'Scale considerations', 'Technology choices justified'],
    commonMistakes: ['Too high-level without specifics', 'No mention of tradeoffs or alternatives considered'],
    tags: ['system-design', 'architecture', 'tradeoffs'],
  },
  // MBA/Business Questions
  {
    domain: 'business', interviewType: 'behavioral', seniorityBand: '*',
    question: 'Tell me about a time you influenced a strategic decision without having direct authority.',
    category: 'behavioral', targetCompetencies: ['leadership', 'strategic_thinking'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Clearly describes the decision and context', 'Shows influence tactics used', 'Demonstrates impact on outcome', 'Reflects on leadership approach'],
    commonMistakes: ['Story about executing someone else\'s decision', 'No evidence of influence'],
    tags: ['leadership', 'influence', 'strategy'],
  },
  // Sales Questions
  {
    domain: 'business', interviewType: 'behavioral', seniorityBand: '*',
    question: 'Walk me through your biggest deal from first contact to close. What made it successful?',
    category: 'behavioral', targetCompetencies: ['persuasion', 'pipeline_management', 'relationship_building'],
    difficulty: 'medium' as const,
    idealAnswerPoints: ['Names deal size or significance', 'Shows full sales cycle', 'Explains relationship building', 'Mentions overcoming objections'],
    commonMistakes: ['No specifics on deal size or timeline', 'Only describes the close, not the journey'],
    tags: ['deal-closing', 'pipeline', 'relationship-building'],
  },
]

// ─── Built-in Company Patterns ──────────────────────────────────────────────

const BUILT_IN_COMPANY_PATTERNS = [
  {
    companyName: 'amazon',
    companyType: 'faang' as const,
    interviewStyle: 'Leadership Principles-based behavioral interviews. Every answer should map to 1-2 LPs.',
    commonRounds: ['phone_screen', 'behavioral_lp', 'bar_raiser', 'hiring_manager'],
    culturalValues: ['customer_obsession', 'ownership', 'bias_for_action', 'dive_deep', 'earn_trust', 'deliver_results'],
    knownQuestionPatterns: [
      'Tell me about a time you [LP-related scenario]',
      'Give me an example of when you disagreed with your manager',
      'How do you handle competing priorities with tight deadlines',
    ],
    interviewTips: [
      'Structure every answer around Amazon Leadership Principles',
      'Always quantify impact with specific metrics',
      'The Bar Raiser evaluates cultural fit — demonstrate ownership',
    ],
    applicableDomains: [],
    evaluationFocus: ['ownership', 'metrics_thinking', 'customer_obsession'],
  },
  {
    companyName: 'google',
    companyType: 'faang' as const,
    interviewStyle: 'Structured interviews with Googleyness assessment. Focus on problem-solving and collaboration.',
    commonRounds: ['phone_screen', 'onsite_behavioral', 'team_matching', 'hiring_committee'],
    culturalValues: ['intellectual_humility', 'collaboration', 'user_focus', 'innovation'],
    knownQuestionPatterns: [
      'How do you approach ambiguous problems?',
      'Tell me about a time you had to influence without authority',
      'Describe a project where you had to learn something completely new',
    ],
    interviewTips: [
      'Show intellectual curiosity and willingness to learn',
      'Demonstrate collaborative problem-solving approach',
      'Googleyness: show you can work with diverse perspectives',
    ],
    applicableDomains: [],
    evaluationFocus: ['collaboration', 'problem_solving', 'innovation'],
  },
  {
    companyName: 'meta',
    companyType: 'faang' as const,
    interviewStyle: 'Move fast culture. Emphasis on impact, speed, and execution.',
    commonRounds: ['phone_screen', 'onsite_behavioral', 'execution_case', 'hiring_manager'],
    culturalValues: ['move_fast', 'be_bold', 'focus_on_impact', 'build_social_value'],
    knownQuestionPatterns: [
      'Tell me about the most impactful project you worked on',
      'How do you move fast without breaking things?',
      'Describe a time you took a calculated risk',
    ],
    interviewTips: [
      'Emphasize speed of execution and measurable impact',
      'Show comfort with ambiguity and rapid iteration',
      'Quantify everything — revenue, users, engagement metrics',
    ],
    applicableDomains: [],
    evaluationFocus: ['execution', 'metrics_thinking', 'boldness'],
  },
  {
    companyName: 'mckinsey',
    companyType: 'consulting' as const,
    interviewStyle: 'Case-based interviews with structured problem-solving. PEI (Personal Experience Interview) for behavioral.',
    commonRounds: ['pei_behavioral', 'case_interview', 'partner_interview'],
    culturalValues: ['structured_thinking', 'client_impact', 'hypothesis_driven', 'one_firm'],
    knownQuestionPatterns: [
      'PEI: leadership, personal impact, entrepreneurial drive',
      'Case: market sizing, profitability, market entry',
      'How would you structure an approach to [business problem]?',
    ],
    interviewTips: [
      'Use frameworks but don\'t be formulaic',
      'Always state your hypothesis upfront',
      'PEI answers need extreme specificity — names, numbers, timelines',
    ],
    applicableDomains: ['business'],
    evaluationFocus: ['structured_thinking', 'framework_usage', 'quantitative_reasoning'],
  },
]

// ─── Built-in Benchmark Cases ───────────────────────────────────────────────

const BUILT_IN_BENCHMARKS = [
  {
    caseId: 'pm_hr_mid_001',
    domain: 'pm',
    interviewType: 'behavioral',
    seniorityBand: '3-6',
    question: 'Tell me about a time you launched a product feature that didn\'t meet expectations. What did you do?',
    candidateAnswer: 'At my last company, we launched a new onboarding flow for our app. We spent three months building it based on what we thought users wanted. After launch, the completion rate actually dropped by 15%. I quickly set up user interviews and found that we had made the flow too long. We simplified it from 8 steps to 4, and within two weeks the completion rate went back up and eventually exceeded the old flow by 10%. I learned that we should have done user testing earlier.',
    expectedStrengthTags: ['clear_structure', 'specific_metrics', 'learning_mindset'],
    expectedWeaknessTags: ['limited_stakeholder_mention', 'could_describe_decision_process_better'],
    expectedCompetencyScoreBands: {
      relevance: { min: 75, max: 95 },
      structure: { min: 65, max: 85 },
      specificity: { min: 70, max: 90 },
      ownership: { min: 70, max: 90 },
    },
    expectedFollowUpRelevance: 'medium' as const,
    idealFollowUpExamples: ['What did you learn about user research from this experience?', 'How did you communicate the failure to stakeholders?'],
    idealFeedbackPoints: ['Good use of specific metrics', 'Shows ability to recover from failure', 'Could include more about stakeholder communication'],
    isFullSession: false,
    expectedOverallScoreBand: { min: 70, max: 85 },
    category: 'pm_behavioral',
    tags: ['failure', 'recovery', 'metrics'],
  },
  {
    caseId: 'swe_hr_entry_001',
    domain: 'backend',
    interviewType: 'behavioral',
    seniorityBand: '0-2',
    question: 'Tell me about a challenging technical problem you solved recently.',
    candidateAnswer: 'Um, so like at my internship I had this bug that was really hard. The API was returning wrong data sometimes. I spent like a day figuring it out and it turned out to be a race condition. I fixed it by adding a mutex. My manager said good job.',
    expectedStrengthTags: ['identified_root_cause'],
    expectedWeaknessTags: ['vague', 'missing_details', 'high_filler_count', 'no_metrics'],
    expectedCompetencyScoreBands: {
      relevance: { min: 50, max: 70 },
      structure: { min: 25, max: 45 },
      specificity: { min: 20, max: 40 },
      ownership: { min: 40, max: 60 },
    },
    expectedFollowUpRelevance: 'high' as const,
    idealFollowUpExamples: ['Can you walk me through exactly how you identified it was a race condition?', 'What was the impact of this bug on users?'],
    idealFeedbackPoints: ['Answer needs more structure', 'Should include impact and scale', 'Too many filler words'],
    isFullSession: false,
    expectedOverallScoreBand: { min: 35, max: 55 },
    category: 'swe_behavioral',
    tags: ['debugging', 'entry-level', 'weak-answer'],
  },
]

// ─── Seed Functions ─────────────────────────────────────────────────────────

export async function seedRubrics() {
  await connectDB()
  for (const rubric of BUILT_IN_RUBRICS) {
    await EvaluationRubric.findOneAndUpdate(
      { rubricId: rubric.rubricId },
      { ...rubric, isActive: true },
      { upsert: true, new: true }
    )
  }
  return { rubrics: BUILT_IN_RUBRICS.length }
}

export async function seedQuestionBank() {
  await connectDB()
  for (const q of BUILT_IN_QUESTIONS) {
    await QuestionBank.findOneAndUpdate(
      { domain: q.domain, question: q.question },
      { ...q, isActive: true },
      { upsert: true, new: true }
    )
  }
  return { questions: BUILT_IN_QUESTIONS.length }
}

export async function seedCompanyPatterns() {
  await connectDB()
  for (const p of BUILT_IN_COMPANY_PATTERNS) {
    await CompanyPattern.findOneAndUpdate(
      { companyName: p.companyName },
      { ...p, isActive: true },
      { upsert: true, new: true }
    )
  }
  return { companies: BUILT_IN_COMPANY_PATTERNS.length }
}

export async function seedBenchmarks() {
  await connectDB()
  for (const b of BUILT_IN_BENCHMARKS) {
    await BenchmarkCase.findOneAndUpdate(
      { caseId: b.caseId },
      { ...b, isActive: true },
      { upsert: true, new: true }
    )
  }
  return { benchmarks: BUILT_IN_BENCHMARKS.length }
}

export async function seedAllPersonalization() {
  const [rubrics, questions, companies, benchmarks] = await Promise.all([
    seedRubrics(),
    seedQuestionBank(),
    seedCompanyPatterns(),
    seedBenchmarks(),
  ])
  return { ...rubrics, ...questions, ...companies, ...benchmarks }
}
