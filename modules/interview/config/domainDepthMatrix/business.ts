import type { DomainDepthOverride } from './types'

export const businessOverrides: Record<string, DomainDepthOverride> = {
  'business:screening': {
    questionStrategy: 'Probe motivation for business/strategy roles, analytical thinking, leadership potential, and culture fit. Ask about their business background, what kind of strategic problems excite them, and their career trajectory in consulting or corporate strategy.',
    interviewerTone: 'Professional and intellectually curious. Show interest in their strategic thinking even during an initial screen.',
    scoringEmphasis: 'Evaluate communication polish, structured thinking signals, leadership potential, culture fit for strategy-oriented teams, and genuine interest in business problem-solving.',
    sampleOpeners: [
      'What draws you to strategy and business roles?',
      'Tell me about a business problem you solved that you found particularly interesting.',
    ],
  },
  'business:behavioral': {
    questionStrategy: 'Explore scenarios around influencing senior stakeholders, driving cross-functional initiatives, making decisions with incomplete data, managing ambiguous projects, and leading through organizational change.',
    interviewerTone: 'Senior business leader who values executive presence and structured communication. Interested in strategic decision-making and stakeholder influence.',
    scoringEmphasis: 'Evaluate executive communication, structured problem-solving, ability to influence without authority, comfort with ambiguity, and strategic leadership maturity.',
    sampleOpeners: [
      'Tell me about a time you influenced a C-suite decision. What was your approach?',
      'Describe a situation where you had to drive alignment across teams with conflicting priorities.',
    ],
  },
  'business:technical': {
    questionStrategy: 'Deep-dive into strategy frameworks (Porter, BCG matrix, blue ocean), financial analysis (P&L, unit economics, valuation basics), market sizing and estimation, competitive analysis, and data-driven business decision-making.',
    interviewerTone: 'Strategy consultant who values rigorous analytical thinking. Test framework application and quantitative reasoning.',
    technicalTranslation: 'Technical means: strategy frameworks, financial modeling basics, market sizing, competitive analysis, unit economics, and data-driven business reasoning.',
    scoringEmphasis: 'Evaluate framework selection and application, quantitative reasoning, market analysis depth, ability to synthesize data into strategic recommendations, and financial literacy.',
    sampleOpeners: [
      'How would you evaluate whether a company should enter a new geographic market?',
      'Walk me through how you would analyze the unit economics of a subscription business.',
    ],
  },
  'business:case-study': {
    questionStrategy: 'Present classic business strategy cases: market entry analysis, M&A evaluation, pricing strategy, turnaround scenario, competitive response strategy, or growth plan for a scaling startup.',
    interviewerTone: 'Case interviewer in the consulting tradition. Present the case, provide data when asked, and probe the candidate\'s framework and logic.',
    technicalTranslation: 'Case study means: structured business problem-solving involving market analysis, financial reasoning, strategic recommendation, and implementation planning.',
    scoringEmphasis: 'Evaluate case structuring ability, hypothesis-driven approach, quantitative analysis, quality of recommendation, and ability to handle pushback on assumptions.',
    sampleOpeners: [
      'A mid-size SaaS company is considering acquiring a competitor. How would you evaluate this decision?',
      'A retail chain is losing market share to online competitors. Develop a turnaround strategy.',
    ],
  },
}
