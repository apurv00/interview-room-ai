import type { PoolQuestion } from './types'

export const pmQuestions: Record<string, PoolQuestion[]> = {
  'pm:screening': [
    { question: 'What excites you most about product management?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'product examples' },
    { question: 'Tell me about a product you use daily. What would you improve about it?', experience: '0-2', targetCompetency: 'product_sense', followUpTheme: 'user empathy' },
    { question: 'Why did you choose PM over engineering or design?', experience: '3-6', targetCompetency: 'career_direction', followUpTheme: 'strengths leveraged' },
    { question: 'What is your product management philosophy in one sentence?', experience: '3-6', targetCompetency: 'pm_philosophy', followUpTheme: 'how it evolved' },
    { question: 'How do you think about scaling a product organization?', experience: '7+', targetCompetency: 'leadership_vision', followUpTheme: 'team structure' },
    { question: 'What separates a good PM from a great one at the senior level?', experience: '7+', targetCompetency: 'self_awareness', followUpTheme: 'personal growth areas' },
    { question: 'Tell me about a product decision you made that you are most proud of.', experience: 'all', targetCompetency: 'impact', followUpTheme: 'how you decided' },
  ],
  'pm:behavioral': [
    { question: 'Tell me about a time engineering and design disagreed on a product direction. What did you do?', experience: '0-2', targetCompetency: 'stakeholder_mgmt', followUpTheme: 'resolution approach' },
    { question: 'Describe a feature you shipped that did not hit its success metrics. What happened?', experience: '0-2', targetCompetency: 'learning_from_failure', followUpTheme: 'what changed after' },
    { question: 'Tell me about the hardest prioritization call you have ever made.', experience: '3-6', targetCompetency: 'prioritization', followUpTheme: 'framework used' },
    { question: 'Describe a time you killed a feature after significant investment. What was the process?', experience: '3-6', targetCompetency: 'strategic_courage', followUpTheme: 'stakeholder communication' },
    { question: 'Tell me about a time you influenced the CEO or executive team to change product strategy.', experience: '7+', targetCompetency: 'executive_influence', followUpTheme: 'data and storytelling' },
    { question: 'How did you manage a product pivot when the market shifted unexpectedly?', experience: '7+', targetCompetency: 'strategic_adaptation', followUpTheme: 'team and customer impact' },
    { question: 'Describe a time you had to say no to a powerful stakeholder. How did you handle it?', experience: 'all', targetCompetency: 'backbone', followUpTheme: 'relationship preservation' },
  ],
  'pm:technical': [
    { question: 'How would you define and measure success for a new onboarding flow?', experience: '0-2', targetCompetency: 'metrics_literacy', followUpTheme: 'leading vs lagging indicators' },
    { question: 'Estimate the number of food delivery orders placed daily in your city.', experience: '0-2', targetCompetency: 'estimation', followUpTheme: 'assumption validation' },
    { question: 'How would you design an A/B test to measure the impact of a pricing change?', experience: '3-6', targetCompetency: 'experimentation', followUpTheme: 'statistical considerations' },
    { question: 'Your retention metric dropped 5% this month. Walk me through your investigation.', experience: '3-6', targetCompetency: 'analytical_thinking', followUpTheme: 'root cause methodology' },
    { question: 'How would you build a product metrics framework for a platform with 10 product areas?', experience: '7+', targetCompetency: 'metrics_architecture', followUpTheme: 'team autonomy vs alignment' },
    { question: 'How do you evaluate an engineering team proposal when you do not have the technical expertise?', experience: '7+', targetCompetency: 'technical_judgment', followUpTheme: 'building technical intuition' },
    { question: 'How do you decide when to trust data versus intuition in a product decision?', experience: 'all', targetCompetency: 'decision_making', followUpTheme: 'examples of each' },
  ],
  'pm:case-study': [
    { question: 'You are the PM for a music streaming app. Design a feature to help users discover new artists.', experience: '0-2', targetCompetency: 'product_design', followUpTheme: 'user segmentation' },
    { question: 'Prioritize these three features for next quarter and explain your reasoning.', experience: '0-2', targetCompetency: 'prioritization', followUpTheme: 'stakeholder alignment' },
    { question: 'Your CEO wants to expand into a new market. How would you evaluate and plan the launch?', experience: '3-6', targetCompetency: 'market_analysis', followUpTheme: 'go-to-market strategy' },
    { question: 'Design a marketplace feature that balances the needs of both buyers and sellers.', experience: '3-6', targetCompetency: 'two_sided_thinking', followUpTheme: 'metrics for each side' },
    { question: 'A competitor just launched a feature that undercuts your core value prop. What do you do?', experience: '7+', targetCompetency: 'competitive_strategy', followUpTheme: 'short-term vs long-term response' },
    { question: 'Design a product strategy for a company transitioning from B2C to B2B.', experience: '7+', targetCompetency: 'strategic_planning', followUpTheme: 'organizational implications' },
    { question: 'You have three months and a team of four. What is the most impactful thing you can build?', experience: 'all', targetCompetency: 'scope_management', followUpTheme: 'tradeoff reasoning' },
  ],
}
