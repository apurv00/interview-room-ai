import type { InterviewConfig } from "@shared/types";

type HireRuntimeInterviewConfig = InterviewConfig & {
  _hireRoundId?: unknown;
  _hireMultimodalObservationsEnabled?: unknown;
  _hireDisplayCaptureRequired?: unknown;
};

/**
 * A Hire interview is identified by the round marker written only by the
 * signed Hire-engine handoff. Keep this client-side discriminator narrow: it
 * changes presentation and runtime preferences only, never authorization.
 */
export function isHireRuntimeInterview(
  config: InterviewConfig | null | undefined,
): boolean {
  const hireRoundId = (config as HireRuntimeInterviewConfig | null | undefined)
    ?._hireRoundId;
  return typeof hireRoundId === "string" && hireRoundId.length > 0;
}

/**
 * The runtime writes this marker only after it has verified the immutable
 * Hire consent receipt/version. It is a client collection gate, never an
 * authorization decision—the fenced capture endpoint repeats the check.
 */
export function isHireRuntimeMultimodalObservationsEnabled(
  config: InterviewConfig | null | undefined,
): boolean {
  return (
    isHireRuntimeInterview(config) &&
    (config as HireRuntimeInterviewConfig | null | undefined)
      ?._hireMultimodalObservationsEnabled === true
  );
}

/**
 * Only the authenticated V6 bootstrap marker requires display capture. Like
 * the other Hire runtime markers, this is a client setup gate; it is never an
 * authorization decision and capture endpoints repeat the binding check.
 */
export function isHireRuntimeDisplayCaptureRequired(
  config: InterviewConfig | null | undefined,
): boolean {
  return (
    isHireRuntimeInterview(config) &&
    (config as HireRuntimeInterviewConfig | null | undefined)
      ?._hireDisplayCaptureRequired === true
  );
}

/**
 * A consumer privacy-mode room intentionally drops the camera recording. A
 * Hire room's immutable consent instead promises a recorded interview to the
 * hiring team, so stale/direct `privacyMode` config must not suppress it.
 */
export function shouldStoreCameraRecording(
  config: InterviewConfig | null | undefined,
): boolean {
  return isHireRuntimeInterview(config) || config?.privacyMode !== true;
}

/**
 * Carries the immutable room choices across the lobby → room navigation.
 * Hire interviews are real assessments, so coaching is always off and the
 * Indian-English voice/STT choice is always on. Ordinary interviews retain
 * their existing user-selected behavior.
 */
export function buildInterviewRoomSearch(
  config: InterviewConfig | null | undefined,
  {
    liveCoachingEnabled,
    indianVoice,
  }: {
    liveCoachingEnabled: boolean;
    indianVoice: boolean;
  },
): string {
  const isHireInterview = isHireRuntimeInterview(config);
  const params = new URLSearchParams();

  if (isHireInterview || !liveCoachingEnabled) params.set("lc", "0");
  if (isHireInterview || indianVoice) params.set("voice", "indian");

  return params.toString();
}
