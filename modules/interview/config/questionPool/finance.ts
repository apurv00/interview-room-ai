import type { PoolQuestion } from './types'

export const financeQuestions: Record<string, PoolQuestion[]> = {
  'finance:screening': [
    { question: 'What area of finance are you most passionate about and why?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'career direction' },
    { question: 'Tell me about a financial analysis that influenced a business decision.', experience: '0-2', targetCompetency: 'impact', followUpTheme: 'methodology used' },
    { question: 'How did you decide between corporate finance, investment banking, and other paths?', experience: '3-6', targetCompetency: 'career_direction', followUpTheme: 'key experiences' },
    { question: 'What financial concept do you find most elegant and why?', experience: '3-6', targetCompetency: 'intellectual_curiosity', followUpTheme: 'practical application' },
    { question: 'How do you see the finance function evolving with AI and automation?', experience: '7+', targetCompetency: 'industry_vision', followUpTheme: 'team implications' },
    { question: 'What is your philosophy on the role of finance in strategic decision-making?', experience: '7+', targetCompetency: 'strategic_thinking', followUpTheme: 'influence examples' },
    { question: 'What was the most challenging financial problem you have worked on?', experience: 'all', targetCompetency: 'analytical_depth', followUpTheme: 'approach and resolution' },
  ],
  'finance:behavioral': [
    { question: 'Tell me about a time you had to deliver bad financial news to leadership.', experience: '0-2', targetCompetency: 'communication_courage', followUpTheme: 'how they reacted' },
    { question: 'Describe a situation where you identified a financial risk others had missed.', experience: '0-2', targetCompetency: 'risk_awareness', followUpTheme: 'escalation process' },
    { question: 'Tell me about a time you navigated budget conflicts between departments.', experience: '3-6', targetCompetency: 'stakeholder_management', followUpTheme: 'resolution approach' },
    { question: 'Describe an ethical dilemma you faced in financial reporting. How did you handle it?', experience: '3-6', targetCompetency: 'integrity', followUpTheme: 'policy implications' },
    { question: 'Tell me about leading your team through a major audit or regulatory challenge.', experience: '7+', targetCompetency: 'crisis_leadership', followUpTheme: 'process improvements' },
    { question: 'How did you influence a CEO or board on a financial strategy they were resistant to?', experience: '7+', targetCompetency: 'executive_influence', followUpTheme: 'framing approach' },
    { question: 'Describe a financial forecast that was significantly wrong. What did you learn?', experience: 'all', targetCompetency: 'learning_from_failure', followUpTheme: 'process changes' },
  ],
  'finance:technical': [
    { question: 'Walk me through how you would value a pre-revenue SaaS company.', experience: '0-2', targetCompetency: 'valuation', followUpTheme: 'methodology selection' },
    { question: 'How would you analyze whether a company can take on additional debt?', experience: '0-2', targetCompetency: 'financial_analysis', followUpTheme: 'key metrics and ratios' },
    { question: 'Build a financial model to evaluate a potential acquisition target.', experience: '3-6', targetCompetency: 'financial_modeling', followUpTheme: 'key assumptions and sensitivity' },
    { question: 'How do you approach building a three-year forecast for a high-growth company?', experience: '3-6', targetCompetency: 'forecasting', followUpTheme: 'driver-based approach' },
    { question: 'What is your framework for evaluating complex capital allocation decisions?', experience: '7+', targetCompetency: 'capital_allocation', followUpTheme: 'risk-adjusted returns' },
    { question: 'How do you think about optimal capital structure for a company approaching IPO?', experience: '7+', targetCompetency: 'strategic_finance', followUpTheme: 'market conditions impact' },
    { question: 'Walk me through how you identify the key value drivers in a financial model.', experience: 'all', targetCompetency: 'financial_reasoning', followUpTheme: 'sensitivity analysis' },
  ],
  'finance:case-study': [
    { question: 'A startup is trying to choose between equity and debt financing. Advise them.', experience: '0-2', targetCompetency: 'capital_structure', followUpTheme: 'tradeoff analysis' },
    { question: 'Analyze this P&L and identify the three biggest opportunities for margin improvement.', experience: '0-2', targetCompetency: 'financial_analysis', followUpTheme: 'implementation priorities' },
    { question: 'Evaluate whether a company should acquire a competitor at 5x revenue.', experience: '3-6', targetCompetency: 'ma_analysis', followUpTheme: 'synergy estimation' },
    { question: 'A company has $50M in free cash flow. Design a capital allocation strategy.', experience: '3-6', targetCompetency: 'capital_allocation', followUpTheme: 'stakeholder tradeoffs' },
    { question: 'A portfolio company is underperforming. Design a financial turnaround plan.', experience: '7+', targetCompetency: 'turnaround_finance', followUpTheme: 'cash flow priorities' },
    { question: 'Design the financial strategy for a company doing a dual-track IPO/M&A process.', experience: '7+', targetCompetency: 'strategic_finance', followUpTheme: 'optionality management' },
    { question: 'Revenue is growing 30% but cash is running out in 6 months. What do you do?', experience: 'all', targetCompetency: 'crisis_finance', followUpTheme: 'runway extension options' },
  ],
}
