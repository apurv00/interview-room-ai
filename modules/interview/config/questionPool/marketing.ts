import type { PoolQuestion } from './types'

export const marketingQuestions: Record<string, PoolQuestion[]> = {
  'marketing:screening': [
    { question: 'What type of marketing excites you most — brand, growth, content, or something else?', experience: '0-2', targetCompetency: 'marketing_identity', followUpTheme: 'why this area' },
    { question: 'Tell me about a campaign you ran that you are especially proud of.', experience: '0-2', targetCompetency: 'campaign_experience', followUpTheme: 'your specific role' },
    { question: 'How do you balance creativity with data in your marketing approach?', experience: '3-6', targetCompetency: 'strategic_balance', followUpTheme: 'concrete examples' },
    { question: 'What is your marketing philosophy and how has it evolved?', experience: '3-6', targetCompetency: 'professional_growth', followUpTheme: 'formative experiences' },
    { question: 'How do you think about building a marketing team from scratch?', experience: '7+', targetCompetency: 'leadership', followUpTheme: 'hiring priorities' },
    { question: 'What trends do you see reshaping marketing in the next 3 years?', experience: '7+', targetCompetency: 'industry_vision', followUpTheme: 'preparation strategy' },
    { question: 'What is the most creative marketing solution you have ever developed?', experience: 'all', targetCompetency: 'creativity', followUpTheme: 'business impact' },
  ],
  'marketing:behavioral': [
    { question: 'Tell me about a campaign that did not perform as expected. What happened?', experience: '0-2', targetCompetency: 'learning_from_failure', followUpTheme: 'what changed after' },
    { question: 'Describe a time you had to completely pivot a marketing strategy mid-execution.', experience: '0-2', targetCompetency: 'adaptability', followUpTheme: 'decision speed' },
    { question: 'Tell me about a time you had to fight for marketing budget against competing priorities.', experience: '3-6', targetCompetency: 'executive_influence', followUpTheme: 'ROI argument' },
    { question: 'Describe how you navigated a brand crisis or negative PR situation.', experience: '3-6', targetCompetency: 'crisis_management', followUpTheme: 'recovery strategy' },
    { question: 'Tell me about building a marketing organization from early stage to mature.', experience: '7+', targetCompetency: 'organizational_building', followUpTheme: 'key hires and structure' },
    { question: 'How did you align product and marketing when they had conflicting positioning views?', experience: '7+', targetCompetency: 'cross_functional_alignment', followUpTheme: 'resolution framework' },
    { question: 'Describe a time you took a creative risk in marketing. What was the outcome?', experience: 'all', targetCompetency: 'risk_taking', followUpTheme: 'decision process' },
  ],
  'marketing:technical': [
    { question: 'How do you approach marketing attribution when customers interact across multiple channels?', experience: '0-2', targetCompetency: 'attribution', followUpTheme: 'tool choices' },
    { question: 'Walk me through how you analyze a marketing funnel to find the biggest drop-off.', experience: '0-2', targetCompetency: 'funnel_analysis', followUpTheme: 'optimization approach' },
    { question: 'How would you build a growth model for a B2B SaaS product?', experience: '3-6', targetCompetency: 'growth_modeling', followUpTheme: 'key assumptions' },
    { question: 'Describe your approach to designing marketing experiments with proper controls.', experience: '3-6', targetCompetency: 'experimentation', followUpTheme: 'statistical rigor' },
    { question: 'How would you architect a martech stack for a company spending $10M annually on marketing?', experience: '7+', targetCompetency: 'martech_architecture', followUpTheme: 'integration challenges' },
    { question: 'What is your framework for measuring the incremental impact of brand marketing?', experience: '7+', targetCompetency: 'brand_measurement', followUpTheme: 'methodological challenges' },
    { question: 'How do you calculate and optimize customer acquisition cost across channels?', experience: 'all', targetCompetency: 'cac_optimization', followUpTheme: 'channel mix decisions' },
  ],
  'marketing:case-study': [
    { question: 'Launch a new DTC wellness brand with a $500K annual marketing budget.', experience: '0-2', targetCompetency: 'launch_strategy', followUpTheme: 'channel prioritization' },
    { question: 'Design a content marketing strategy for a B2B software company targeting CTOs.', experience: '0-2', targetCompetency: 'content_strategy', followUpTheme: 'distribution and measurement' },
    { question: 'A B2B SaaS company is shifting from PLG to enterprise sales. Design the marketing transition.', experience: '3-6', targetCompetency: 'gtm_strategy', followUpTheme: 'team and process changes' },
    { question: 'A competitor with 3x your budget is winning search and paid channels. What do you do?', experience: '3-6', targetCompetency: 'competitive_marketing', followUpTheme: 'asymmetric strategies' },
    { question: 'Design a global marketing strategy for a brand expanding from the US to 5 new markets.', experience: '7+', targetCompetency: 'global_marketing', followUpTheme: 'localization vs standardization' },
    { question: 'You need to cut marketing spend by 30% without losing revenue. Build the plan.', experience: '7+', targetCompetency: 'budget_optimization', followUpTheme: 'measurement and tradeoffs' },
    { question: 'Your CEO wants to understand marketing ROI. How do you build the measurement framework?', experience: 'all', targetCompetency: 'roi_measurement', followUpTheme: 'attribution methodology' },
  ],
}
