import type { PoolQuestion } from './types'

export const salesQuestions: Record<string, PoolQuestion[]> = {
  'sales:screening': [
    { question: 'Give me your 60-second pitch on yourself — sell me on why you are a great salesperson.', experience: '0-2', targetCompetency: 'self_presentation', followUpTheme: 'authenticity and energy' },
    { question: 'What type of sales environment brings out your best performance?', experience: '0-2', targetCompetency: 'self_awareness', followUpTheme: 'concrete examples' },
    { question: 'How would you describe your sales style — are you a hunter, farmer, or something else?', experience: '3-6', targetCompetency: 'sales_identity', followUpTheme: 'evolution over time' },
    { question: 'What is the most important thing you have learned about selling?', experience: '3-6', targetCompetency: 'sales_wisdom', followUpTheme: 'how you learned it' },
    { question: 'How do you think about building and leading a high-performing sales team?', experience: '7+', targetCompetency: 'sales_leadership', followUpTheme: 'hiring and culture' },
    { question: 'What separates a good salesperson from a great one at the enterprise level?', experience: '7+', targetCompetency: 'strategic_selling', followUpTheme: 'personal development areas' },
    { question: 'What drives you in sales beyond the commission check?', experience: 'all', targetCompetency: 'intrinsic_motivation', followUpTheme: 'specific stories' },
  ],
  'sales:behavioral': [
    { question: 'Tell me about your biggest lost deal. What happened and what did you learn?', experience: '0-2', targetCompetency: 'resilience', followUpTheme: 'applied learning' },
    { question: 'Describe a time you turned around a deal that was going sideways.', experience: '0-2', targetCompetency: 'deal_craft', followUpTheme: 'specific tactics used' },
    { question: 'Tell me about a deal where you had to navigate a complex buying committee.', experience: '3-6', targetCompetency: 'complex_selling', followUpTheme: 'stakeholder mapping' },
    { question: 'Describe a time you had to rebuild a pipeline during a dry spell.', experience: '3-6', targetCompetency: 'pipeline_resilience', followUpTheme: 'prospecting strategy' },
    { question: 'Tell me about coaching a struggling rep to quota attainment.', experience: '7+', targetCompetency: 'sales_coaching', followUpTheme: 'diagnosis and intervention' },
    { question: 'Describe leading your team through a quarter where hitting target seemed impossible.', experience: '7+', targetCompetency: 'team_leadership', followUpTheme: 'motivation tactics' },
    { question: 'Tell me about the best objection you have ever handled. What made it effective?', experience: 'all', targetCompetency: 'objection_handling', followUpTheme: 'underlying technique' },
  ],
  'sales:technical': [
    { question: 'Walk me through how you qualify a deal using your preferred methodology.', experience: '0-2', targetCompetency: 'deal_qualification', followUpTheme: 'disqualification criteria' },
    { question: 'How do you use your CRM to manage pipeline and forecast accurately?', experience: '0-2', targetCompetency: 'crm_discipline', followUpTheme: 'data hygiene' },
    { question: 'Compare MEDDIC and Challenger — when would you use each?', experience: '3-6', targetCompetency: 'methodology_depth', followUpTheme: 'practical application' },
    { question: 'How do you build a pipeline forecast your leadership can rely on?', experience: '3-6', targetCompetency: 'forecasting', followUpTheme: 'accuracy methodology' },
    { question: 'How would you design a territory and compensation plan for a new market?', experience: '7+', targetCompetency: 'sales_operations', followUpTheme: 'incentive alignment' },
    { question: 'What is your approach to building a sales enablement program from scratch?', experience: '7+', targetCompetency: 'enablement_design', followUpTheme: 'measuring effectiveness' },
    { question: 'How do you analyze your win/loss data to improve conversion rates?', experience: 'all', targetCompetency: 'sales_analytics', followUpTheme: 'actionable changes' },
  ],
  'sales:case-study': [
    { question: 'You are launching a new product with no existing customer base. Build your first-year sales plan.', experience: '0-2', targetCompetency: 'gtm_planning', followUpTheme: 'prospecting strategy' },
    { question: 'Design an account strategy for a Fortune 500 company you want to land.', experience: '0-2', targetCompetency: 'account_strategy', followUpTheme: 'stakeholder engagement' },
    { question: 'Your region is at 60% of quota halfway through the year. What is your recovery plan?', experience: '3-6', targetCompetency: 'pipeline_recovery', followUpTheme: 'activity math' },
    { question: 'A major competitor is undercutting your pricing by 40%. Design a competitive response.', experience: '3-6', targetCompetency: 'competitive_selling', followUpTheme: 'value differentiation' },
    { question: 'Design the GTM sales strategy for entering an enterprise market dominated by an incumbent.', experience: '7+', targetCompetency: 'market_entry', followUpTheme: 'competitive displacement' },
    { question: 'Build a partner channel program that generates 30% of revenue within 18 months.', experience: '7+', targetCompetency: 'channel_strategy', followUpTheme: 'partner economics' },
    { question: 'Your biggest customer is threatening to churn. What do you do in the next 48 hours?', experience: 'all', targetCompetency: 'retention_strategy', followUpTheme: 'escalation and negotiation' },
  ],
}
