import {
  HireEngineConfigSchema,
  type HireEngineConfig,
} from '@shared/contracts/hireEngineBridge'

/**
 * Cross the runtime persistence boundary with plain, strictly validated data.
 * Mongoose nested documents expose enumerable helpers that must never leak
 * into wire payloads or the unchanged interview-engine service contract.
 */
export function runtimeEngineConfig(value: unknown): HireEngineConfig {
  const plain =
    value &&
    typeof value === 'object' &&
    typeof (value as { toObject?: unknown }).toObject === 'function'
      ? (value as { toObject: () => unknown }).toObject()
      : value
  return HireEngineConfigSchema.parse(plain)
}
