import { describe, expect, it } from "vitest";
import type { InterviewConfig } from "@shared/types";
import {
  buildInterviewRoomSearch,
  isHireRuntimeInterview,
  isHireRuntimeMultimodalObservationsEnabled,
  shouldStoreCameraRecording,
} from "@interview/config/hireRuntimeMode";
import { __hireMultimodalCapture } from "@interview/hooks/useHireMultimodalCapture";

const STANDARD_CONFIG: InterviewConfig = {
  role: "Software Engineer",
  experience: "3-6",
  duration: 15,
};

const HIRE_CONFIG = {
  ...STANDARD_CONFIG,
  _hireRoundId: "66f2d848791b2d3b4e5f6001",
} as InterviewConfig;

describe("Hire runtime interview mode", () => {
  it("recognizes only the signed-handoff round marker", () => {
    expect(isHireRuntimeInterview(STANDARD_CONFIG)).toBe(false);
    expect(isHireRuntimeInterview(HIRE_CONFIG)).toBe(true);
    expect(isHireRuntimeInterview(null)).toBe(false);
  });

  it("forces coaching off and Indian voice for Hire room navigation", () => {
    expect(
      buildInterviewRoomSearch(HIRE_CONFIG, {
        liveCoachingEnabled: true,
        indianVoice: false,
      }),
    ).toBe("lc=0&voice=indian");
  });

  it("enables Hire-native collection only for a runtime-verifiable consent marker", () => {
    expect(isHireRuntimeMultimodalObservationsEnabled(HIRE_CONFIG)).toBe(false);
    expect(
      isHireRuntimeMultimodalObservationsEnabled({
        ...HIRE_CONFIG,
        _hireMultimodalObservationsEnabled: true,
      } as InterviewConfig),
    ).toBe(true);
    expect(isHireRuntimeMultimodalObservationsEnabled(STANDARD_CONFIG)).toBe(false);
  });

  it("preserves ordinary interview choices", () => {
    expect(
      buildInterviewRoomSearch(STANDARD_CONFIG, {
        liveCoachingEnabled: true,
        indianVoice: false,
      }),
    ).toBe("");

    expect(
      buildInterviewRoomSearch(STANDARD_CONFIG, {
        liveCoachingEnabled: false,
        indianVoice: true,
      }),
    ).toBe("lc=0&voice=indian");
  });

  it("keeps Hire recording enabled even when a direct/stale room config carries privacyMode", () => {
    expect(shouldStoreCameraRecording({ ...STANDARD_CONFIG, privacyMode: true })).toBe(false);
    expect(shouldStoreCameraRecording({ ...HIRE_CONFIG, privacyMode: true })).toBe(true);
    expect(shouldStoreCameraRecording(HIRE_CONFIG)).toBe(true);
  });

  it("pins camera collection WASM to the reviewed MediaPipe release", () => {
    expect(__hireMultimodalCapture.MEDIAPIPE_WASM_ROOT).toContain(
      "@mediapipe/tasks-vision@0.10.34",
    );
    expect(__hireMultimodalCapture.MEDIAPIPE_WASM_ROOT).not.toContain("@latest");
  });
});
