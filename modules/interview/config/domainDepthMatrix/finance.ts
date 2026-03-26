import type { DomainDepthOverride } from './types'

export const financeOverrides: Record<string, DomainDepthOverride> = {
  'finance:screening': {
    questionStrategy: 'Probe motivation for finance, analytical orientation, career trajectory, and culture fit. Ask about what area of finance excites them (corporate finance, investment banking, FP&A), their approach to financial problem-solving, and career goals.',
    interviewerTone: 'Professional and analytically sharp. Show respect for financial rigor while keeping the conversation accessible.',
    scoringEmphasis: 'Evaluate financial acumen signals, communication clarity about complex topics, culture fit for finance teams, and genuine interest in financial analysis.',
    antiPatterns: 'Do NOT ask technical modeling questions or valuation exercises. Screening focuses on motivation, financial curiosity, and culture fit for finance teams.',
    experienceCalibration: {
      '0-2': 'Expect genuine interest in finance, basic understanding of financial concepts, and clear career direction. Probe analytical thinking and passion for financial problem-solving.',
      '3-6': 'Expect a defined finance career path, concrete examples of financial analysis impact, and confident communication of complex topics. Probe depth of financial interest and specialization.',
      '7+': 'Expect a senior finance leadership perspective, strategic financial thinking, and clear vision for their career trajectory. Probe leadership philosophy and views on finance function evolution.',
    },
    domainRedFlags: [
      'Cannot articulate what area of finance interests them or why',
      'Struggles to explain basic financial concepts in simple terms',
      'Shows no awareness of current financial markets or economic trends',
    ],
  },
  'finance:behavioral': {
    questionStrategy: 'Explore scenarios around presenting unfavorable financial findings to leadership, managing audit pressure, handling ethical dilemmas in financial reporting, navigating budget conflicts between departments, and leading through financial uncertainty.',
    interviewerTone: 'Senior finance leader who values integrity and precision. Interested in how they handle the tension between business pressure and financial accuracy.',
    scoringEmphasis: 'Evaluate integrity under pressure, communication of complex financial information, ability to influence business decisions through financial insight, and leadership during financial uncertainty.',
    antiPatterns: 'Do NOT ask for financial modeling or technical valuation. Behavioral for finance means integrity under pressure, communicating financial insights, and navigating organizational dynamics around money.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 examples of delivering financial analysis to stakeholders, basic integrity in reporting, and clear communication of numbers. Probe honesty and precision under pressure.',
      '3-6': 'Expect strong examples of presenting difficult financial findings, navigating budget politics, and influencing business decisions through financial insight. Probe integrity and communication maturity.',
      '7+': 'Expect sophisticated examples of leading through financial crises, managing board-level financial communication, and building finance team culture around integrity. Probe leadership during financial uncertainty.',
    },
    domainRedFlags: [
      'Avoids discussing mistakes or financial misses',
      'Cannot explain complex financial concepts in simple terms',
      'Shows willingness to bend financial reporting under business pressure',
      'Takes credit for positive outcomes but blames others for financial misses',
    ],
  },
  'finance:technical': {
    questionStrategy: 'Deep-dive into financial modeling (DCF, LBO, comparable analysis), valuation methodology, risk assessment frameworks, financial statement analysis, budgeting and forecasting, and regulatory/compliance knowledge.',
    interviewerTone: 'Technical finance professional who expects analytical rigor. Test modeling skills and financial reasoning, not just formula knowledge.',
    technicalTranslation: 'Technical means: DCF and valuation modeling, financial statement analysis, risk assessment frameworks, budgeting/forecasting methodology, capital structure decisions, and regulatory compliance.',
    scoringEmphasis: 'Evaluate financial modeling proficiency, valuation methodology understanding, ability to identify key drivers and sensitivities, risk assessment rigor, and practical application of financial concepts.',
    antiPatterns: 'Do NOT ask behavioral or situational questions. Technical for finance means DCF modeling, valuation, financial statement analysis, and quantitative risk assessment.',
    experienceCalibration: {
      '0-2': 'Expect basic understanding of DCF concepts, ability to read financial statements, and familiarity with comparable analysis. Probe analytical reasoning over model complexity.',
      '3-6': 'Expect proficiency in DCF modeling, comparable analysis, and basic LBO. Probe practical deal experience and ability to communicate financial insights.',
      '7+': 'Expect mastery of complex valuation methodologies, sophisticated sensitivity analysis, and deep understanding of capital structure and risk. Probe strategic financial judgment and mentoring ability.',
    },
    domainRedFlags: [
      'Cannot walk through a basic DCF model or explain its key assumptions',
      'Memorizes formulas without understanding underlying financial logic',
      'Ignores sensitivity analysis or presents single-point estimates as definitive',
    ],
  },
  'finance:case-study': {
    questionStrategy: 'Present finance scenarios: evaluate an M&A target, design a capital allocation strategy, assess the financial viability of a new business line, create a risk management framework, or develop a restructuring plan.',
    interviewerTone: 'Investment committee member who provides financial data and constraints. Expect structured analysis with quantitative support.',
    technicalTranslation: 'Case study means: financial analysis exercises involving valuation, capital allocation, risk assessment, and strategic financial decision-making with real numbers.',
    scoringEmphasis: 'Evaluate analytical structure, quantitative rigor, ability to identify key assumptions and sensitivities, quality of financial recommendation, and consideration of risk factors.',
    antiPatterns: 'Do NOT use generic business strategy cases without financial data. Finance case studies must involve real numbers, models, and quantitative analysis.',
    experienceCalibration: {
      '0-2': 'Expect a structured approach to financial analysis, basic valuation attempt, and a clear recommendation with key assumptions stated. Probe logical reasoning over model sophistication.',
      '3-6': 'Expect rigorous financial analysis with multiple valuation approaches, sensitivity analysis, and a well-defended recommendation. Probe ability to identify key risks and handle data ambiguity.',
      '7+': 'Expect sophisticated multi-scenario analysis, creative deal structuring, and executive-ready recommendations with risk mitigation strategies. Probe strategic financial judgment under uncertainty.',
    },
    domainRedFlags: [
      'Cannot structure a financial analysis or identify key value drivers',
      'Presents recommendations without quantitative support',
      'Ignores risk factors or downside scenarios entirely',
      'Cannot identify or articulate key assumptions underlying the analysis',
    ],
  },
}
