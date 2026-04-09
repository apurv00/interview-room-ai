import { connectDB } from '@shared/db/connection'
import { QuestionBank } from '@shared/db/models'
import type { IQuestionBank } from '@shared/db/models'
import { isFeatureEnabled } from '@shared/featureFlags'
import { logger } from '@shared/logger'

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

/**
 * Generate an embedding vector for text using OpenAI's API.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured for embeddings')

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI embedding failed: ${response.status} ${err}`)
  }

  const data = await response.json()
  return data.data[0].embedding as number[]
}

/**
 * Semantic search for questions using vector similarity.
 * Falls back to text search if embeddings are unavailable.
 */
export async function vectorSearchQuestions(
  query: string,
  filters?: { domain?: string; interviewType?: string; difficulty?: string },
  limit: number = 5
): Promise<IQuestionBank[]> {
  if (!isFeatureEnabled('embedding_search')) return []

  try {
    await connectDB()

    const queryEmbedding = await generateEmbedding(query)

    // MongoDB Atlas Vector Search aggregation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: 'question_embedding_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 10,
          limit: limit * 2,
        },
      },
      // Apply filters after vector search
      {
        $match: {
          isActive: true,
          ...(filters?.domain && { domain: filters.domain }),
          ...(filters?.interviewType && { interviewType: filters.interviewType }),
          ...(filters?.difficulty && { difficulty: filters.difficulty }),
        },
      },
      { $limit: limit },
      {
        $project: {
          embedding: 0,  // exclude large vector from results
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]

    const results = await QuestionBank.aggregate(pipeline)
    return results as IQuestionBank[]
  } catch (err) {
    // Vector search may fail if index doesn't exist yet — fall back gracefully
    logger.warn({ err }, 'Vector search failed, falling back to text search')
    return []
  }
}

/**
 * Backfill embeddings for all questions that don't have them yet.
 * Run as a one-time script or cron job.
 */
export async function backfillEmbeddings(
  batchSize: number = 50
): Promise<{ processed: number; errors: number }> {
  await connectDB()

  const questions = await QuestionBank.find({
    embedding: { $exists: false },
    isActive: true,
  }).limit(batchSize).select('question category targetCompetencies domain')

  let processed = 0
  let errors = 0

  for (const q of questions) {
    try {
      // Build embedding text from question + metadata for richer semantic matching
      const text = `${q.question} [${q.category}] [${q.domain}] ${q.targetCompetencies.join(', ')}`
      const embedding = await generateEmbedding(text)

      await QuestionBank.findByIdAndUpdate(q._id, {
        embedding,
        embeddedAt: new Date(),
      })

      processed++
    } catch (err) {
      logger.error({ err, questionId: q._id }, 'Failed to generate embedding')
      errors++
    }
  }

  logger.info({ processed, errors, total: questions.length }, 'Embedding backfill completed')
  return { processed, errors }
}
