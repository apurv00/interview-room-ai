import type { DomainDepthOverride } from './types'

export const marketingOverrides: Record<string, DomainDepthOverride> = {
  'marketing:screening': {
    questionStrategy: 'Probe motivation for marketing, creative vs. analytical orientation, campaign experience highlights, and culture fit. Ask about their marketing philosophy, favorite campaigns they have run, and what type of marketing excites them most.',
    interviewerTone: 'Energetic and brand-aware. Show interest in both their creative instincts and analytical capabilities.',
    scoringEmphasis: 'Evaluate marketing passion, communication style, balance of creativity and data-orientation, culture fit, and ability to articulate marketing strategy.',
    sampleOpeners: [
      'What type of marketing excites you most — brand, growth, content, or something else?',
      'Tell me about a campaign you ran that you are especially proud of.',
    ],
  },
  'marketing:behavioral': {
    questionStrategy: 'Explore scenarios around managing campaign failures, navigating brand-vs-performance tension, handling tight launch deadlines, influencing product teams on positioning, and adapting strategy when market conditions shift suddenly.',
    interviewerTone: 'Marketing leader who understands the pressure of campaigns and brand reputation. Interested in adaptability and strategic thinking under constraints.',
    scoringEmphasis: 'Evaluate adaptability, creative problem-solving under constraints, cross-functional influence, ability to learn from campaign failures, and strategic communication.',
    sampleOpeners: [
      'Tell me about a campaign that did not perform as expected. What happened and what did you learn?',
      'Describe a time you had to completely pivot a marketing strategy mid-execution.',
    ],
  },
  'marketing:technical': {
    questionStrategy: 'Deep-dive into marketing analytics (attribution modeling, funnel analysis, LTV/CAC), martech stack (CRM, CDP, marketing automation), SEO/SEM strategy, content strategy, growth loops, and experimentation in marketing.',
    interviewerTone: 'Data-driven marketing leader who values analytical rigor alongside creative strategy.',
    technicalTranslation: 'Technical means: marketing analytics and attribution, martech platforms, SEO/SEM methodology, growth modeling, funnel optimization, and experimentation frameworks.',
    scoringEmphasis: 'Evaluate analytics sophistication, martech proficiency, understanding of attribution challenges, ability to connect marketing metrics to business outcomes, and growth strategy thinking.',
    sampleOpeners: [
      'How do you approach marketing attribution when customers interact across multiple channels?',
      'Walk me through how you would build a growth model for a B2B SaaS product.',
    ],
  },
  'marketing:case-study': {
    questionStrategy: 'Present marketing strategy scenarios: launch a product in a crowded market, design a go-to-market plan for a new segment, create a brand repositioning strategy, develop a content marketing engine, or plan a competitive response campaign.',
    interviewerTone: 'CMO-level interviewer who provides market context and budget constraints. Let the candidate structure the strategy while probing channel selection and measurement.',
    technicalTranslation: 'Case study means: marketing strategy exercises involving market analysis, channel strategy, budget allocation, messaging development, and measurement planning.',
    scoringEmphasis: 'Evaluate strategic marketing thinking, channel selection rationale, budget allocation logic, measurement framework, and ability to connect marketing activities to revenue.',
    sampleOpeners: [
      'Launch a new direct-to-consumer brand in the crowded wellness space with a $500K annual budget. What is your strategy?',
      'A B2B SaaS company is shifting from PLG to enterprise sales. Design the marketing strategy for this transition.',
    ],
  },
}
