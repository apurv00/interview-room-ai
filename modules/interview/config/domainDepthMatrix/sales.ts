import type { DomainDepthOverride } from './types'

export const salesOverrides: Record<string, DomainDepthOverride> = {
  'sales:screening': {
    questionStrategy: 'Probe motivation for sales, competitive drive, relationship-building style, and culture fit. Ask about their sales philosophy, biggest wins, what type of sales environment they thrive in (transactional vs. enterprise), and career aspirations.',
    interviewerTone: 'Direct and energetic. Mirror the pace and confidence expected in sales roles. Show interest in their competitive spirit.',
    scoringEmphasis: 'Evaluate communication confidence, enthusiasm for sales, culture fit for sales-driven organizations, relationship-building signals, and career ambition clarity.',
    antiPatterns: 'Do NOT ask about sales methodology frameworks or pipeline management. Screening focuses on motivation, competitive drive, and culture fit for sales teams.',
    experienceCalibration: {
      '0-2': 'Expect raw energy and enthusiasm for sales, basic understanding of the sales process, and a competitive mindset. Probe coachability and hunger over polish.',
      '3-6': 'Expect a clear sales identity (hunter vs. farmer, SMB vs. enterprise), concrete quota attainment history, and confident communication. Probe self-awareness about sales strengths.',
      '7+': 'Expect a sales leadership perspective, views on building and scaling sales teams, and strategic thinking about market development. Probe leadership philosophy and revenue strategy vision.',
    },
    domainRedFlags: [
      'Cannot articulate what excites them about sales or why they chose it',
      'Avoids discussing specific numbers or quota attainment',
      'Shows no competitive drive or energy during the conversation',
    ],
  },
  'sales:behavioral': {
    questionStrategy: 'Explore scenarios around losing a major deal, handling persistent objections, recovering a churning account, navigating internal conflicts over deal terms, managing a difficult sales cycle, and building pipeline during dry spells.',
    interviewerTone: 'Sales leader who has been in the trenches. Interested in resilience, deal craft, and honest reflection on losses — not just highlight reels.',
    scoringEmphasis: 'Evaluate resilience and grit, deal-craft sophistication, ability to learn from lost deals, relationship management depth, and honest self-assessment.',
    antiPatterns: 'Do NOT ask about sales methodology theory or CRM proficiency. Behavioral for sales means deal resilience, objection handling, and honest reflection on wins and losses.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 examples of handling rejection, basic objection handling, and willingness to learn from lost opportunities. Probe resilience and coachability.',
      '3-6': 'Expect detailed examples of navigating complex deal cycles, recovering difficult accounts, and learning from significant losses. Probe deal-craft sophistication and self-awareness.',
      '7+': 'Expect sophisticated examples of managing high-stakes enterprise deals, coaching reps through difficult cycles, and building resilient sales culture. Probe leadership through revenue adversity.',
    },
    domainRedFlags: [
      'Blames market conditions or territory for missed quota',
      'Cannot articulate specific deal metrics (pipeline, win rate, deal size)',
      'Takes credit for team results without describing personal contribution',
      'Only discusses wins and cannot reflect on losses or mistakes',
    ],
  },
  'sales:technical': {
    questionStrategy: 'Deep-dive into sales methodology (MEDDIC, SPIN, Challenger, Solution Selling), pipeline management and forecasting, CRM optimization, territory planning, sales analytics, negotiation frameworks, and competitive selling strategies.',
    interviewerTone: 'Sales operations leader who values methodology and process alongside hustle. Test strategic selling thinking, not just activity metrics.',
    technicalTranslation: 'Technical means: sales methodology frameworks (MEDDIC, SPIN, Challenger), pipeline management and forecasting accuracy, CRM usage, territory planning, deal qualification criteria, and sales analytics.',
    scoringEmphasis: 'Evaluate sales methodology depth, pipeline management sophistication, ability to articulate deal qualification criteria, forecasting accuracy approach, and strategic territory planning.',
    antiPatterns: 'Do NOT ask coding or engineering questions. Technical for sales means sales methodology (MEDDIC/SPIN/Challenger), CRM proficiency, pipeline analytics, and forecasting.',
    experienceCalibration: {
      '0-2': 'Expect basic understanding of one sales methodology, familiarity with CRM tools, and simple pipeline management. Probe willingness to adopt process discipline.',
      '3-6': 'Expect fluency in at least one methodology (MEDDIC, SPIN, or Challenger), solid pipeline management practices, and data-driven forecasting. Probe practical application and deal qualification rigor.',
      '7+': 'Expect mastery of multiple sales methodologies, ability to design territory and compensation plans, sophisticated forecasting models. Probe strategic revenue leadership.',
    },
    domainRedFlags: [
      'Cannot articulate a deal qualification framework or methodology',
      'Relies on gut feeling for forecasting without data-driven processes',
      'Shows no CRM discipline or pipeline management rigor',
      'Cannot explain how they prioritize accounts or territories',
    ],
  },
  'sales:case-study': {
    questionStrategy: 'Present sales strategy scenarios: develop a go-to-market plan for a new product, design a territory plan for an underperforming region, create an enterprise account strategy, plan a competitive displacement campaign, or build a partner channel program.',
    interviewerTone: 'VP of Sales who provides market context, quota targets, and resource constraints. Expect strategic thinking about pipeline building and revenue achievement.',
    technicalTranslation: 'Case study means: sales strategy exercises involving GTM planning, territory design, account strategy, competitive analysis, and revenue forecasting.',
    scoringEmphasis: 'Evaluate strategic sales thinking, ability to connect activities to revenue targets, territory and account planning rigor, competitive awareness, and realistic resource allocation.',
    antiPatterns: 'Do NOT present abstract business strategy cases without revenue targets. Sales case studies must involve quota, pipeline, territory, and concrete revenue goals.',
    experienceCalibration: {
      '0-2': 'Expect a basic GTM plan structure (target accounts, outreach strategy, pipeline targets), reasonable activity metrics, and enthusiasm. Probe strategic thinking over tactical sophistication.',
      '3-6': 'Expect a well-structured territory or account plan with pipeline math, competitive positioning, and resource allocation. Probe ability to connect activities to revenue outcomes and handle quota pressure.',
      '7+': 'Expect sophisticated sales strategy with multi-channel GTM, partner leverage, competitive displacement tactics, and detailed revenue modeling. Probe strategic leadership and organizational design thinking.',
    },
    domainRedFlags: [
      'Cannot connect sales activities to pipeline and revenue targets',
      'Proposes plans without considering resource constraints or quota math',
      'Ignores competitive dynamics in territory or account planning',
      'No mention of measurement, pipeline stages, or conversion metrics',
    ],
  },
}
