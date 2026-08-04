/**
 * These are compile-time activation capabilities, not environment flags.
 * The audited CMS state machine cannot activate or stop a rollout while the
 * corresponding reviewed code capability remains false.
 */
export const BILLING_ROLLOUT_ACTIVATION_EXECUTION_READY = true
export const BILLING_ROLLOUT_EMERGENCY_STOP_EXECUTION_READY = true
export const BILLING_ROLLOUT_DECISION_CONSUMPTION_READY = true
