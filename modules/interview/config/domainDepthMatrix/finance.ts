import type { DomainDepthOverride } from './types'

export const financeOverrides: Record<string, DomainDepthOverride> = {
  'finance:screening': {
    questionStrategy: 'Probe motivation for finance, analytical orientation, career trajectory, and culture fit. Ask about what area of finance excites them (corporate finance, investment banking, FP&A), their approach to financial problem-solving, and career goals.',
    interviewerTone: 'Professional and analytically sharp. Show respect for financial rigor while keeping the conversation accessible.',
    scoringEmphasis: 'Evaluate financial acumen signals, communication clarity about complex topics, culture fit for finance teams, and genuine interest in financial analysis.',
    sampleOpeners: [
      'What area of finance are you most passionate about and why?',
      'Tell me about a financial analysis you did that influenced a significant business decision.',
    ],
  },
  'finance:behavioral': {
    questionStrategy: 'Explore scenarios around presenting unfavorable financial findings to leadership, managing audit pressure, handling ethical dilemmas in financial reporting, navigating budget conflicts between departments, and leading through financial uncertainty.',
    interviewerTone: 'Senior finance leader who values integrity and precision. Interested in how they handle the tension between business pressure and financial accuracy.',
    scoringEmphasis: 'Evaluate integrity under pressure, communication of complex financial information, ability to influence business decisions through financial insight, and leadership during financial uncertainty.',
    sampleOpeners: [
      'Tell me about a time you had to deliver bad financial news to senior leadership.',
      'Describe a situation where you identified a significant financial risk others had missed.',
    ],
  },
  'finance:technical': {
    questionStrategy: 'Deep-dive into financial modeling (DCF, LBO, comparable analysis), valuation methodology, risk assessment frameworks, financial statement analysis, budgeting and forecasting, and regulatory/compliance knowledge.',
    interviewerTone: 'Technical finance professional who expects analytical rigor. Test modeling skills and financial reasoning, not just formula knowledge.',
    technicalTranslation: 'Technical means: DCF and valuation modeling, financial statement analysis, risk assessment frameworks, budgeting/forecasting methodology, capital structure decisions, and regulatory compliance.',
    scoringEmphasis: 'Evaluate financial modeling proficiency, valuation methodology understanding, ability to identify key drivers and sensitivities, risk assessment rigor, and practical application of financial concepts.',
    sampleOpeners: [
      'Walk me through how you would value a pre-revenue SaaS company.',
      'How would you build a financial model to evaluate a potential acquisition target?',
    ],
  },
  'finance:case-study': {
    questionStrategy: 'Present finance scenarios: evaluate an M&A target, design a capital allocation strategy, assess the financial viability of a new business line, create a risk management framework, or develop a restructuring plan.',
    interviewerTone: 'Investment committee member who provides financial data and constraints. Expect structured analysis with quantitative support.',
    technicalTranslation: 'Case study means: financial analysis exercises involving valuation, capital allocation, risk assessment, and strategic financial decision-making with real numbers.',
    scoringEmphasis: 'Evaluate analytical structure, quantitative rigor, ability to identify key assumptions and sensitivities, quality of financial recommendation, and consideration of risk factors.',
    sampleOpeners: [
      'Evaluate whether this company should acquire a competitor at a 5x revenue multiple. Here is the financial data.',
      'A company has $50M in free cash flow. Design a capital allocation strategy and defend your choices.',
    ],
  },
}
