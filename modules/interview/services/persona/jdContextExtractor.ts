import { completion } from '@shared/services/modelRouter'
import { aiLogger } from '@shared/logger'

export interface CompanyContext {
  company: string | null
  industry: string | null
}

// Common patterns for extracting company name from JD text
const COMPANY_PATTERNS = [
  /\bAbout\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s*\n|\s*[.!])/,
  /\bat\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s*[.,!)\n])/,
  /\bjoin(?:ing)?\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s*[.,!)\n])/i,
  /\b([A-Z][A-Za-z0-9&.\-' ]{1,60}?)\s+is\s+(?:a\s+)?(?:leading|global|fast-growing|innovative|premier|top)/,
  /\bwork(?:ing)?\s+(?:at|for|with)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s*[.,!)\n])/i,
  /^([A-Z][A-Za-z0-9&.\-' ]{1,60}?)\s+(?:is\s+)?(?:hiring|looking|seeking)/m,
  /\bCompany:\s*([A-Za-z0-9&.\-' ]{1,60})/i,
  /\bEmployer:\s*([A-Za-z0-9&.\-' ]{1,60})/i,
]

// Industry keyword mapping
const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  'Technology': ['software', 'saas', 'cloud', 'tech', 'platform', 'digital', 'ai', 'machine learning', 'data'],
  'Financial Services': ['banking', 'fintech', 'financial', 'investment', 'insurance', 'trading', 'payments', 'wealth management'],
  'Healthcare': ['health', 'medical', 'pharma', 'biotech', 'clinical', 'patient', 'hospital', 'telemedicine'],
  'E-commerce & Retail': ['e-commerce', 'ecommerce', 'retail', 'marketplace', 'shopping', 'consumer goods'],
  'Media & Entertainment': ['media', 'entertainment', 'streaming', 'gaming', 'content', 'publishing', 'news'],
  'Education': ['education', 'edtech', 'learning', 'university', 'academic', 'school', 'training'],
  'Consulting': ['consulting', 'advisory', 'management consulting', 'professional services', 'strategy'],
  'Manufacturing': ['manufacturing', 'industrial', 'supply chain', 'logistics', 'automotive', 'aerospace'],
  'Real Estate': ['real estate', 'property', 'construction', 'housing', 'commercial real estate'],
  'Energy': ['energy', 'oil', 'gas', 'renewable', 'solar', 'clean energy', 'utilities'],
  'Telecommunications': ['telecom', 'telecommunications', 'wireless', 'network', '5g'],
  'Government & Public Sector': ['government', 'federal', 'public sector', 'defense', 'military'],
}

function extractCompanyByRegex(text: string): string | null {
  for (const pattern of COMPANY_PATTERNS) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const name = match[1].trim()
      // Filter out generic words that aren't company names
      const generic = ['the', 'a', 'an', 'our', 'this', 'your', 'we', 'they', 'team', 'company', 'organization']
      if (name.length >= 2 && !generic.includes(name.toLowerCase())) {
        return name
      }
    }
  }
  return null
}

function extractIndustryByKeywords(text: string): string | null {
  const lower = text.toLowerCase()
  let bestMatch: string | null = null
  let bestCount = 0

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    const count = keywords.filter(kw => lower.includes(kw)).length
    if (count > bestCount) {
      bestCount = count
      bestMatch = industry
    }
  }

  return bestCount >= 1 ? bestMatch : null
}

/**
 * Extract company name and industry from JD text.
 * Uses regex/heuristics first, falls back to Claude Haiku for stubborn cases.
 */
export async function extractCompanyContext(jdText: string): Promise<CompanyContext> {
  if (!jdText || jdText.trim().length < 50) {
    return { company: null, industry: null }
  }

  const company = extractCompanyByRegex(jdText)
  const industry = extractIndustryByKeywords(jdText)

  // If regex found both, return immediately (no API call needed)
  if (company && industry) {
    return { company, industry }
  }

  // If we have at least partial results from regex, try AI only for missing pieces
  // If regex found nothing, try Claude Haiku for extraction
  if (!company || !industry) {
    try {
      const response = await completion({
        taskSlot: 'interview.jd-extract',
        system: 'Extract structured information from job descriptions. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Extract the company name and industry from this job description. Return ONLY a JSON object with "company" and "industry" fields. Use null if not found.\n\nJob description (first 2000 chars):\n${jdText.slice(0, 2000)}`,
        }],
      })

      const raw = response.text || '{}'
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      const parsed = JSON.parse(cleaned)

      return {
        company: company || parsed.company || null,
        industry: industry || parsed.industry || null,
      }
    } catch (err) {
      aiLogger.warn({ err }, 'Failed to extract company context via AI')
    }
  }

  return { company, industry }
}
