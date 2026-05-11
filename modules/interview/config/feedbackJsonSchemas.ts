import type { JsonSchema } from '@shared/services/providers'

const stringArray = {
  type: 'array',
  items: { type: 'string' },
} as const

const answerQualitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'strengths', 'weaknesses'],
  properties: {
    score: { type: 'number' },
    strengths: stringArray,
    weaknesses: stringArray,
  },
} as const

const communicationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'wpm', 'filler_rate', 'pause_score', 'rambling_index'],
  properties: {
    score: { type: 'number' },
    wpm: { type: 'number' },
    filler_rate: { type: 'number' },
    pause_score: { type: 'number' },
    rambling_index: { type: 'number' },
  },
} as const

const engagementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'engagement_score', 'confidence_trend', 'energy_consistency', 'composure_under_pressure'],
  properties: {
    score: { type: 'number' },
    engagement_score: { type: 'number' },
    confidence_trend: { type: 'string', enum: ['increasing', 'stable', 'declining'] },
    energy_consistency: { type: 'number' },
    composure_under_pressure: { type: 'number' },
  },
} as const

export const FeedbackCoreJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overall_score',
    'pass_probability',
    'confidence_level',
    'dimensions',
    'red_flags',
    'top_3_improvements',
    'jd_match_score',
    'jd_requirement_breakdown',
  ],
  properties: {
    overall_score: { type: 'number' },
    pass_probability: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    confidence_level: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['answer_quality', 'communication', 'engagement_signals'],
      properties: {
        answer_quality: answerQualitySchema,
        communication: communicationSchema,
        engagement_signals: engagementSchema,
      },
    },
    red_flags: stringArray,
    top_3_improvements: stringArray,
    jd_match_score: { type: ['number', 'null'] },
    jd_requirement_breakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'matched', 'evidence'],
        properties: {
          requirement: { type: 'string' },
          matched: { type: 'boolean' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const satisfies JsonSchema

export const FeedbackEnrichmentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ideal_answers', 'drill_recommendations'],
  properties: {
    ideal_answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionIndex', 'strongAnswer', 'keyElements'],
        properties: {
          questionIndex: { type: 'number' },
          strongAnswer: { type: 'string' },
          keyElements: stringArray,
        },
      },
    },
    drill_recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['skillArea', 'description', 'practiceQuestions'],
        properties: {
          skillArea: { type: 'string' },
          description: { type: 'string' },
          practiceQuestions: stringArray,
        },
      },
    },
  },
} as const satisfies JsonSchema

export const FEEDBACK_CORE_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  name: 'feedback_core',
  strict: true,
  schema: FeedbackCoreJsonSchema,
}

export const FEEDBACK_ENRICHMENT_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  name: 'feedback_enrichment',
  strict: true,
  schema: FeedbackEnrichmentJsonSchema,
}

export function lintStrictJsonSchema(schema: JsonSchema): string[] {
  const issues: string[] = []

  function visit(node: unknown, path: string) {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (path === '$' && ('oneOf' in obj || 'anyOf' in obj)) {
      issues.push(`${path}: root oneOf/anyOf is not supported for strict structured outputs`)
    }

    const type = obj.type
    const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'))
    if (isObject) {
      if (obj.additionalProperties !== false) {
        issues.push(`${path}: object schemas must set additionalProperties=false`)
      }
      const properties = obj.properties
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        issues.push(`${path}: object schemas must define properties`)
      } else {
        const propertyNames = Object.keys(properties)
        const required = Array.isArray(obj.required) ? obj.required : []
        for (const name of propertyNames) {
          if (!required.includes(name)) {
            issues.push(`${path}: required is missing property "${name}"`)
          }
          visit((properties as Record<string, unknown>)[name], `${path}.properties.${name}`)
        }
        for (const name of required) {
          if (typeof name !== 'string' || !propertyNames.includes(name)) {
            issues.push(`${path}: required references unknown property "${String(name)}"`)
          }
        }
      }
    }

    if (obj.items) {
      visit(obj.items, `${path}.items`)
    }
  }

  visit(schema, '$')
  return issues
}
