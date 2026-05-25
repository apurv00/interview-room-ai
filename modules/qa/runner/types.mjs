/**
 * @typedef {'interview' | 'feedback' | 'analysis' | 'pathway' | 'drill' | 'setup'} QaStage
 * @typedef {'pass' | 'warn' | 'fail'} ActivityVerdict
 *
 * @typedef {Object} ConsoleEntry
 * @property {'log' | 'warn' | 'error' | 'debug'} level
 * @property {string} text
 * @property {number} timestamp
 *
 * @typedef {Object} NetworkEntry
 * @property {string} method
 * @property {string} url
 * @property {number | null} status
 * @property {number} durationMs
 * @property {boolean} failed
 * @property {string} [responseBodyPreview]
 *
 * @typedef {Object} AssertionResult
 * @property {string} id
 * @property {boolean} pass
 * @property {string} message
 * @property {'fail' | 'warn'} [severity]
 *
 * @typedef {Object} TelemetryBundle
 * @property {string} activityId
 * @property {string} runId
 * @property {string} matrixKey
 * @property {QaStage} stage
 * @property {string} step
 * @property {string} timestamp
 * @property {number} durationMs
 * @property {ConsoleEntry[]} console
 * @property {NetworkEntry[]} network
 * @property {{ ok: boolean, status: number, ms: number, keys: string[] }} [apiResult]
 * @property {AssertionResult[]} assertions
 * @property {ActivityVerdict} verdict
 * @property {string} [sessionId]
 * @property {Record<string, unknown>} [meta]
 */

export {}
