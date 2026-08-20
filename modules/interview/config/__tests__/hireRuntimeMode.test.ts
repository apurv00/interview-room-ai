import { describe, expect, it } from "vitest";
import type { InterviewConfig } from "@shared/types";
import {
  buildInterviewRoomSearch,
  isHireRuntimeDisplayCaptureRequired,
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

  it("requires display capture only for the signed V6 handoff marker", () => {
    expect(isHireRuntimeDisplayCaptureRequired(HIRE_CONFIG)).toBe(false);
    expect(
      isHireRuntimeDisplayCaptureRequired({
        ...HIRE_CONFIG,
        _hireDisplayCaptureRequired: true,
      } as InterviewConfig),
    ).toBe(true);
    expect(isHireRuntimeDisplayCaptureRequired(STANDARD_CONFIG)).toBe(false);
    expect(
      isHireRuntimeDisplayCaptureRequired({
        ...STANDARD_CONFIG,
        _hireDisplayCaptureRequired: true,
      } as InterviewConfig),
    ).toBe(false);
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

  it("reduces local mouth geometry to a short-lived boolean motion proxy", () => {
    const landmarks = Array.from({ length: 264 }, () => ({ x: 0, y: 0 }));
    landmarks[33] = { x: 0, y: 0 };
    landmarks[263] = { x: 1, y: 0 };
    landmarks[13] = { x: 0.5, y: 0.4 };
    landmarks[14] = { x: 0.5, y: 0.5 };

    const opening = __hireMultimodalCapture.normalizedMouthOpening(landmarks);
    expect(opening).toBeCloseTo(0.1);

    const first = __hireMultimodalCapture.nextFacialSpeechActivity({
      previousOpening: null,
      activeUntilMs: 0,
      opening,
      atMs: 0,
    });
    expect(first.facialSpeechActive).toBeNull();

    const moving = __hireMultimodalCapture.nextFacialSpeechActivity({
      previousOpening: first.previousOpening,
      activeUntilMs: first.activeUntilMs,
      opening: 0.11,
      atMs: 200,
    });
    expect(moving.facialSpeechActive).toBe(true);

    const stale = __hireMultimodalCapture.nextFacialSpeechActivity({
      previousOpening: moving.previousOpening,
      activeUntilMs: moving.activeUntilMs,
      opening: 0.11,
      atMs: moving.activeUntilMs + 1,
    });
    expect(stale.facialSpeechActive).toBe(false);
  });
});
