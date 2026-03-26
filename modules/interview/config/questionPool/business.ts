import type { PoolQuestion } from './types'

export const businessQuestions: Record<string, PoolQuestion[]> = {
  'business:screening': [
    { question: 'What draws you to strategy and business roles?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'specific interests' },
    { question: 'Tell me about a business problem you found particularly interesting to solve.', experience: '0-2', targetCompetency: 'analytical_curiosity', followUpTheme: 'approach taken' },
    { question: 'How did your career path lead you to strategy work?', experience: '3-6', targetCompetency: 'career_narrative', followUpTheme: 'key turning points' },
    { question: 'What kind of strategic problems excite you the most?', experience: '3-6', targetCompetency: 'passion', followUpTheme: 'recent examples' },
    { question: 'How do you view the role of strategy in a fast-moving organization?', experience: '7+', targetCompetency: 'strategic_philosophy', followUpTheme: 'execution connection' },
    { question: 'What separates strategic thinking from strategic execution?', experience: '7+', targetCompetency: 'leadership_thinking', followUpTheme: 'personal examples' },
    { question: 'Tell me about a decision you made that had significant business impact.', experience: 'all', targetCompetency: 'impact', followUpTheme: 'how you measured it' },
  ],
  'business:behavioral': [
    { question: 'Tell me about a time you had to make a recommendation with incomplete data.', experience: '0-2', targetCompetency: 'ambiguity_tolerance', followUpTheme: 'how you managed risk' },
    { question: 'Describe a time you influenced a decision without having formal authority.', experience: '0-2', targetCompetency: 'influence', followUpTheme: 'tactics used' },
    { question: 'Tell me about a time you drove alignment across teams with conflicting priorities.', experience: '3-6', targetCompetency: 'cross_functional_leadership', followUpTheme: 'resolution approach' },
    { question: 'Describe a strategic recommendation you made that was initially rejected. What happened?', experience: '3-6', targetCompetency: 'resilience', followUpTheme: 'eventual outcome' },
    { question: 'Tell me about a time you influenced C-suite strategy. What was your approach?', experience: '7+', targetCompetency: 'executive_influence', followUpTheme: 'framing and data' },
    { question: 'Describe leading an organization through a major strategic pivot.', experience: '7+', targetCompetency: 'change_leadership', followUpTheme: 'managing resistance' },
    { question: 'Tell me about the biggest strategic mistake you have made. What did you learn?', experience: 'all', targetCompetency: 'self_awareness', followUpTheme: 'applied learning' },
  ],
  'business:technical': [
    { question: 'How would you size the market for electric scooter rentals in a major city?', experience: '0-2', targetCompetency: 'market_sizing', followUpTheme: 'assumption validation' },
    { question: 'Walk me through how you would analyze the unit economics of a subscription business.', experience: '0-2', targetCompetency: 'financial_literacy', followUpTheme: 'key levers' },
    { question: 'How would you evaluate whether a company should enter a new geographic market?', experience: '3-6', targetCompetency: 'market_analysis', followUpTheme: 'framework application' },
    { question: 'Describe how you would build a competitive analysis for a market with 5 major players.', experience: '3-6', targetCompetency: 'competitive_analysis', followUpTheme: 'strategic implications' },
    { question: 'How do you evaluate the strategic fit of a potential acquisition target?', experience: '7+', targetCompetency: 'ma_analysis', followUpTheme: 'integration planning' },
    { question: 'What is your framework for evaluating build-vs-buy-vs-partner decisions?', experience: '7+', targetCompetency: 'strategic_frameworks', followUpTheme: 'real examples' },
    { question: 'How do you stress-test a strategic assumption when the data is uncertain?', experience: 'all', targetCompetency: 'analytical_rigor', followUpTheme: 'sensitivity methods' },
  ],
  'business:case-study': [
    { question: 'A DTC brand is struggling with customer acquisition costs. How would you advise them?', experience: '0-2', targetCompetency: 'problem_structuring', followUpTheme: 'data requests' },
    { question: 'Should a mid-size SaaS company expand to the European market? Structure your analysis.', experience: '0-2', targetCompetency: 'market_entry', followUpTheme: 'risk assessment' },
    { question: 'A retail chain is losing market share to online competitors. Develop a turnaround strategy.', experience: '3-6', targetCompetency: 'turnaround_strategy', followUpTheme: 'implementation roadmap' },
    { question: 'Evaluate whether this company should acquire a competitor at 5x revenue.', experience: '3-6', targetCompetency: 'ma_evaluation', followUpTheme: 'synergy quantification' },
    { question: 'A PE firm asks you to evaluate a portfolio company that is underperforming. Where do you start?', experience: '7+', targetCompetency: 'diagnostic_analysis', followUpTheme: 'value creation plan' },
    { question: 'Design a 3-year growth strategy for a company transitioning from services to product.', experience: '7+', targetCompetency: 'strategic_planning', followUpTheme: 'phasing and milestones' },
    { question: 'Your client is considering raising prices by 20%. What analysis would you do?', experience: 'all', targetCompetency: 'pricing_analysis', followUpTheme: 'elasticity and competitive response' },
  ],
}
