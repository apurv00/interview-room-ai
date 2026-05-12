import { describe, expect, it } from 'vitest'
import {
  FeedbackCoreJsonSchema,
  FeedbackEnrichmentJsonSchema,
  lintStrictJsonSchema,
} from '../config/feedbackJsonSchemas'

describe('feedback strict JSON schemas', () => {
  it('core feedback schema satisfies strict structured-output constraints', () => {
    expect(lintStrictJsonSchema(FeedbackCoreJsonSchema)).toEqual([])
  })

  it('enrichment schema satisfies strict structured-output constraints', () => {
    expect(lintStrictJsonSchema(FeedbackEnrichmentJsonSchema)).toEqual([])
  })

  it('flags object schemas that omit additionalProperties=false or required fields', () => {
    const issues = lintStrictJsonSchema({
      type: 'object',
      additionalProperties: true,
      required: [],
      properties: {
        value: { type: 'string' },
      },
    })
    expect(issues).toEqual(expect.arrayContaining([
      '$: object schemas must set additionalProperties=false',
      '$: required is missing property "value"',
    ]))
  })
})
