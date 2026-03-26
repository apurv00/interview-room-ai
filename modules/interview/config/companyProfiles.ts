/**
 * Company-specific interview patterns and question banks.
 * For well-known companies, provides interview style context, common question themes,
 * and cultural values that the AI can use to tailor the interview experience.
 */

export interface CompanyProfile {
  name: string
  aliases: string[]             // alternate names for matching (e.g., "GOOG" for Google)
  industry: string
  interviewStyle: string        // description of how this company interviews
  culturalValues: string[]      // core values to weave into questions
  commonThemes: string[]        // question themes this company is known for
  difficultyLevel: string       // "standard" | "high" | "very_high"
  tips: string                  // brief coaching tip for this company
}

export const COMPANY_PROFILES: CompanyProfile[] = [
  {
    name: 'Google',
    aliases: ['Alphabet', 'GOOG', 'Googler'],
    industry: 'Technology',
    interviewStyle: 'Structured interviews with scorecards. Behavioral questions use "Googleyness" criteria. Technical rounds emphasize problem-solving approach over memorized answers. Values intellectual humility and collaboration.',
    culturalValues: ['Innovation', 'User focus', 'Intellectual humility', 'Collaboration', 'Data-driven decisions'],
    commonThemes: ['Ambiguity handling', 'Cross-functional influence', 'Scaling impact', 'Learning from failure', 'User empathy'],
    difficultyLevel: 'very_high',
    tips: 'Google values structured thinking and "Googleyness" — show intellectual curiosity, comfort with ambiguity, and collaborative problem-solving.',
  },
  {
    name: 'Amazon',
    aliases: ['AWS', 'AMZN'],
    industry: 'Technology',
    interviewStyle: 'Leadership Principles (LPs) driven behavioral interviews. Every answer should map to 1-2 LPs. STAR format is essential. Bar raisers look for specific data points and metrics.',
    culturalValues: ['Customer Obsession', 'Ownership', 'Bias for Action', 'Dive Deep', 'Earn Trust', 'Deliver Results'],
    commonThemes: ['Customer obsession examples', 'Disagree and commit', 'Frugality', 'Diving deep into data', 'Earning trust across teams'],
    difficultyLevel: 'very_high',
    tips: 'Amazon interviews are LP-driven. Start every answer by connecting to a Leadership Principle. Use specific metrics and data points.',
  },
  {
    name: 'Meta',
    aliases: ['Facebook', 'META', 'Instagram', 'WhatsApp'],
    industry: 'Technology',
    interviewStyle: 'Focus on impact and scale. Behavioral interviews probe "Move Fast" culture fit. Values candidates who can articulate business impact of technical decisions.',
    culturalValues: ['Move Fast', 'Be Bold', 'Focus on Impact', 'Be Open', 'Build Social Value'],
    commonThemes: ['Shipping at speed', 'Impact measurement', 'Working with ambiguity at scale', 'Cross-team collaboration', 'Bold bets'],
    difficultyLevel: 'very_high',
    tips: 'Meta values speed and impact. Quantify the impact of your work and show comfort making decisions with incomplete information.',
  },
  {
    name: 'Apple',
    aliases: ['AAPL'],
    industry: 'Technology',
    interviewStyle: 'Secretive about process. Values craft, attention to detail, and passion for products. Behavioral questions probe perfectionism balanced with pragmatism.',
    culturalValues: ['Craft and quality', 'Secrecy and focus', 'User experience obsession', 'Simplicity', 'Cross-functional excellence'],
    commonThemes: ['Attention to detail', 'Product passion', 'Collaboration across hardware/software', 'Simplicity in design', 'Quality vs. speed tradeoffs'],
    difficultyLevel: 'very_high',
    tips: 'Apple values craft and product passion. Show deep attention to detail and genuine enthusiasm for creating excellent user experiences.',
  },
  {
    name: 'Microsoft',
    aliases: ['MSFT', 'Azure'],
    industry: 'Technology',
    interviewStyle: 'Growth mindset culture under Satya Nadella. Values learning, empathy, and collaboration. Behavioral rounds focus on growth mindset examples and inclusive leadership.',
    culturalValues: ['Growth mindset', 'Diversity and inclusion', 'Customer empathy', 'One Microsoft collaboration', 'Innovation'],
    commonThemes: ['Learning from mistakes', 'Growth mindset examples', 'Inclusive leadership', 'Customer empathy', 'Cross-org collaboration'],
    difficultyLevel: 'high',
    tips: 'Microsoft emphasizes growth mindset. Show how you learned from failures, supported teammates, and approached challenges with curiosity.',
  },
  {
    name: 'Netflix',
    aliases: ['NFLX'],
    industry: 'Technology',
    interviewStyle: 'Culture memo driven. Values "Freedom and Responsibility." Interviews probe independent judgment, candid feedback, and high performance. Expects candidates to articulate strong opinions.',
    culturalValues: ['Freedom and Responsibility', 'Context not Control', 'Highly Aligned Loosely Coupled', 'Candor', 'Keeper Test'],
    commonThemes: ['Independent judgment', 'Giving/receiving candid feedback', 'High performance standards', 'Strategic thinking', 'Innovation courage'],
    difficultyLevel: 'very_high',
    tips: 'Netflix values independent judgment and candor. Share examples of bold decisions and giving honest feedback, even when uncomfortable.',
  },
  {
    name: 'McKinsey',
    aliases: ['McKinsey & Company', 'McK'],
    industry: 'Consulting',
    interviewStyle: 'Case interviews + PEI (Personal Experience Interview). Cases test structured thinking and mental math. PEI probes leadership, personal impact, and entrepreneurial drive.',
    culturalValues: ['Client impact', 'Structured problem-solving', 'Leadership', 'Obligation to dissent', 'One firm culture'],
    commonThemes: ['Case structuring', 'Top-down communication', 'Personal impact stories', 'Leadership under pressure', 'Client management'],
    difficultyLevel: 'very_high',
    tips: 'McKinsey expects top-down communication and structured frameworks. In cases, always state your approach before diving in. For PEI, prepare 3-4 strong impact stories.',
  },
  {
    name: 'BCG',
    aliases: ['Boston Consulting Group'],
    industry: 'Consulting',
    interviewStyle: 'Case interviews with more creative, less formulaic approach than McKinsey. Values original thinking and ability to push back on assumptions. PEI-style behavioral questions.',
    culturalValues: ['Intellectual curiosity', 'Creative problem-solving', 'Collaborative spirit', 'Client focus', 'Diversity of thought'],
    commonThemes: ['Creative case approaches', 'Hypothesis-driven thinking', 'Team leadership', 'Client relationship building', 'Unconventional insights'],
    difficultyLevel: 'very_high',
    tips: 'BCG values creative thinking in cases. Go beyond standard frameworks — show original thinking and willingness to challenge assumptions.',
  },
  {
    name: 'Goldman Sachs',
    aliases: ['GS', 'Goldman'],
    industry: 'Financial Services',
    interviewStyle: 'Technical finance questions mixed with behavioral. Values work ethic, attention to detail, and market awareness. Super Day format with multiple back-to-back interviews.',
    culturalValues: ['Client service', 'Excellence', 'Integrity', 'Teamwork', 'Commercial mindset'],
    commonThemes: ['Market awareness', 'Financial modeling', 'Team collaboration under pressure', 'Attention to detail', 'Client focus'],
    difficultyLevel: 'very_high',
    tips: 'Goldman values market awareness and analytical rigor. Stay current on markets, and show both technical skills and collaborative teamwork.',
  },
  {
    name: 'JPMorgan',
    aliases: ['JP Morgan', 'JPM', 'Chase', 'J.P. Morgan'],
    industry: 'Financial Services',
    interviewStyle: 'Mix of technical and behavioral. Values risk awareness, analytical thinking, and client relationship skills. Expects knowledge of current financial markets.',
    culturalValues: ['Client focus', 'Risk management', 'Analytical rigor', 'Integrity', 'Innovation'],
    commonThemes: ['Risk assessment', 'Market knowledge', 'Client management', 'Teamwork', 'Ethical decision-making'],
    difficultyLevel: 'high',
    tips: 'JPMorgan values risk awareness and client focus. Demonstrate analytical rigor and show you understand the regulatory and risk landscape.',
  },
  {
    name: 'Stripe',
    aliases: [],
    industry: 'Technology',
    interviewStyle: 'High bar for craft and ownership. Values writing ability, systems thinking, and genuine curiosity about payments infrastructure. Interviews often include take-home projects.',
    culturalValues: ['Users first', 'Move with urgency', 'Think rigorously', 'Trust and amplify', 'Global optimization'],
    commonThemes: ['Systems thinking', 'Ownership and initiative', 'Writing clarity', 'Payments domain knowledge', 'Building for developers'],
    difficultyLevel: 'very_high',
    tips: 'Stripe values craft, clear writing, and systems thinking. Show deep ownership of your work and ability to think about problems end-to-end.',
  },
  {
    name: 'Salesforce',
    aliases: ['SFDC', 'CRM'],
    industry: 'Technology',
    interviewStyle: 'Values-driven (Ohana culture). Behavioral interviews probe trust, customer success, and equality. Technical interviews are collaborative and practical.',
    culturalValues: ['Trust', 'Customer Success', 'Innovation', 'Equality', 'Sustainability'],
    commonThemes: ['Customer success stories', 'Building trust', 'Inclusive leadership', 'Innovation in CRM', 'Collaborative problem-solving'],
    difficultyLevel: 'high',
    tips: 'Salesforce emphasizes trust and customer success. Show how you built customer relationships and drove outcomes aligned with their values.',
  },
]

/**
 * Find a company profile by name (case-insensitive, checks aliases too).
 */
export function findCompanyProfile(companyName: string): CompanyProfile | null {
  if (!companyName) return null
  const lower = companyName.toLowerCase().trim()
  return COMPANY_PROFILES.find(p =>
    p.name.toLowerCase() === lower ||
    p.aliases.some(a => a.toLowerCase() === lower)
  ) || null
}

/**
 * Build a prompt context block for a known company.
 */
export function buildCompanyPromptContext(profile: CompanyProfile): string {
  let ctx = `\nCOMPANY CONTEXT — ${profile.name}:`
  ctx += `\nInterview Style: ${profile.interviewStyle}`
  ctx += `\nCore Values: ${profile.culturalValues.join(', ')}`
  ctx += `\nCommon Question Themes: ${profile.commonThemes.join(', ')}`
  ctx += `\nDifficulty: ${profile.difficultyLevel}`
  return ctx
}
