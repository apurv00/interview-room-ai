import type { DomainDepthOverride } from './types'

export const salesOverrides: Record<string, DomainDepthOverride> = {
  'sales:screening': {
    questionStrategy: 'Probe motivation for sales, competitive drive, relationship-building style, and culture fit. Ask about their sales philosophy, biggest wins, what type of sales environment they thrive in (transactional vs. enterprise), and career aspirations.',
    interviewerTone: 'Direct and energetic. Mirror the pace and confidence expected in sales roles. Show interest in their competitive spirit.',
    scoringEmphasis: 'Evaluate communication confidence, enthusiasm for sales, culture fit for sales-driven organizations, relationship-building signals, and career ambition clarity.',
    sampleOpeners: [
      'Give me your 60-second pitch on yourself — sell me on why you are a great salesperson.',
      'What type of sales environment brings out your best performance?',
    ],
  },
  'sales:behavioral': {
    questionStrategy: 'Explore scenarios around losing a major deal, handling persistent objections, recovering a churning account, navigating internal conflicts over deal terms, managing a difficult sales cycle, and building pipeline during dry spells.',
    interviewerTone: 'Sales leader who has been in the trenches. Interested in resilience, deal craft, and honest reflection on losses — not just highlight reels.',
    scoringEmphasis: 'Evaluate resilience and grit, deal-craft sophistication, ability to learn from lost deals, relationship management depth, and honest self-assessment.',
    sampleOpeners: [
      'Tell me about your biggest lost deal. What happened and what did you learn?',
      'Describe a deal that was going sideways — how did you turn it around?',
    ],
  },
  'sales:technical': {
    questionStrategy: 'Deep-dive into sales methodology (MEDDIC, SPIN, Challenger, Solution Selling), pipeline management and forecasting, CRM optimization, territory planning, sales analytics, negotiation frameworks, and competitive selling strategies.',
    interviewerTone: 'Sales operations leader who values methodology and process alongside hustle. Test strategic selling thinking, not just activity metrics.',
    technicalTranslation: 'Technical means: sales methodology frameworks (MEDDIC, SPIN, Challenger), pipeline management and forecasting accuracy, CRM usage, territory planning, deal qualification criteria, and sales analytics.',
    scoringEmphasis: 'Evaluate sales methodology depth, pipeline management sophistication, ability to articulate deal qualification criteria, forecasting accuracy approach, and strategic territory planning.',
    sampleOpeners: [
      'Walk me through how you qualify a deal using your preferred methodology.',
      'How do you build and manage a pipeline forecast that your leadership can rely on?',
    ],
  },
  'sales:case-study': {
    questionStrategy: 'Present sales strategy scenarios: develop a go-to-market plan for a new product, design a territory plan for an underperforming region, create an enterprise account strategy, plan a competitive displacement campaign, or build a partner channel program.',
    interviewerTone: 'VP of Sales who provides market context, quota targets, and resource constraints. Expect strategic thinking about pipeline building and revenue achievement.',
    technicalTranslation: 'Case study means: sales strategy exercises involving GTM planning, territory design, account strategy, competitive analysis, and revenue forecasting.',
    scoringEmphasis: 'Evaluate strategic sales thinking, ability to connect activities to revenue targets, territory and account planning rigor, competitive awareness, and realistic resource allocation.',
    sampleOpeners: [
      'You are launching a new enterprise product in a market dominated by an incumbent. Design your GTM sales strategy.',
      'Your region is at 60% of quota halfway through the year. What is your recovery plan?',
    ],
  },
}
