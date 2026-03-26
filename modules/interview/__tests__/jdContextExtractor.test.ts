import { describe, it, expect, vi } from 'vitest'

// Mock the Anthropic SDK and logger before importing
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"company": "Acme Corp", "industry": "Technology"}' }],
      }),
    },
  })),
}))

vi.mock('@shared/logger', () => ({
  aiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { extractCompanyContext } from '../services/jdContextExtractor'

describe('extractCompanyContext', () => {
  // ── Empty/short input ──
  it('returns nulls for empty string', async () => {
    const result = await extractCompanyContext('')
    expect(result).toEqual({ company: null, industry: null })
  })

  it('returns nulls for very short text', async () => {
    const result = await extractCompanyContext('Short text')
    expect(result).toEqual({ company: null, industry: null })
  })

  // ── Regex extraction: "About [Company]" pattern ──
  it('extracts company from "About [Company]" pattern', async () => {
    const jd = 'About Google\nWe are looking for a talented engineer to join our team. We work on cloud computing and software development projects.'
    const result = await extractCompanyContext(jd)
    expect(result.company).toBe('Google')
  })

  // ── Regex extraction: "at [Company]" pattern ──
  it('extracts company from "at [Company]" pattern', async () => {
    const jd = 'We are looking for a talented engineer at Microsoft. The role involves building scalable cloud infrastructure and distributed systems.'
    const result = await extractCompanyContext(jd)
    expect(result.company).toBe('Microsoft')
  })

  // ── Regex extraction: "join [Company]" pattern ──
  it('extracts company from "join [Company]" pattern', async () => {
    const jd = 'Come join Stripe, and help us build the economic infrastructure of the internet. We are a technology company in the payments space.'
    const result = await extractCompanyContext(jd)
    expect(result.company).toBe('Stripe')
  })

  // ── Regex extraction: "[Company] is hiring" pattern ──
  it('extracts company from "[Company] is hiring" pattern', async () => {
    const jd = 'Netflix is hiring a Senior Product Manager to lead our content recommendation platform. We are a streaming entertainment company.'
    const result = await extractCompanyContext(jd)
    expect(result.company).toBe('Netflix')
  })

  // ── Industry keyword detection ──
  it('detects Technology industry from keywords', async () => {
    const jd = 'About TechCo\nWe are a SaaS platform building cloud software solutions with AI and machine learning capabilities for enterprise customers.'
    const result = await extractCompanyContext(jd)
    expect(result.industry).toBe('Technology')
  })

  it('detects Financial Services industry from keywords', async () => {
    const jd = 'About FinCo\nWe are a fintech company specializing in banking, investment, and payments solutions for modern financial services.'
    const result = await extractCompanyContext(jd)
    expect(result.industry).toBe('Financial Services')
  })

  it('detects Healthcare industry from keywords', async () => {
    const jd = 'About HealthCo\nWe are a biotech company developing clinical solutions for patient care and medical research in telemedicine.'
    const result = await extractCompanyContext(jd)
    expect(result.industry).toBe('Healthcare')
  })

  it('detects E-commerce & Retail industry from keywords', async () => {
    const jd = 'About ShopCo\nWe are an e-commerce marketplace building the best online shopping experience for consumer goods.'
    const result = await extractCompanyContext(jd)
    expect(result.industry).toBe('E-commerce & Retail')
  })

  // ── Combined extraction ──
  it('extracts both company and industry when both are present', async () => {
    const jd = 'About Acme Corp\nAcme Corp is a leading SaaS platform company building cloud software solutions. We are hiring a senior engineer to work on our AI and data infrastructure.'
    const result = await extractCompanyContext(jd)
    expect(result.company).toBe('Acme Corp')
    expect(result.industry).toBe('Technology')
  })

  // ── Filters out generic words ──
  it('does not extract generic words as company names', async () => {
    const jd = 'We are looking for a talented engineer to join our team. The company is growing fast in the software development space with cloud computing and AI technologies.'
    const result = await extractCompanyContext(jd)
    // "our" and "the" should not be extracted as company names
    expect(result.company).not.toBe('our')
    expect(result.company).not.toBe('The')
  })
})
