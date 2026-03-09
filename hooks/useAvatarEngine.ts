'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AvatarEmotion } from '@/lib/types'
import { LipSyncEngine } from '@/lib/avatar/LipSyncEngine'
import { IdleAnimationEngine, type IdleState } from '@/lib/avatar/IdleAnimations'
import { EmotionEngine, type EmotionState } from '@/lib/avatar/EmotionEngine'

// ─── Combined avatar state ──────────────────────────────────────────────────

export interface AvatarEngineState {
  // Lip sync
  mouthPath: string
  // Emotion
  leftBrow: string
  rightBrow: string
  emotionMouth: string
  mouthFill: string
  cheekOpacity: number
  // Idle
  breathY: number
  headTiltDeg: number
  gazeX: number
  isNodding: boolean
  nodProgress: number
  blinkState: boolean
}

const DEFAULT_STATE: AvatarEngineState = {
  mouthPath: 'M 75 148 Q 100 155 125 148',
  leftBrow: 'M 62 96 Q 80 90 98 96',
  rightBrow: 'M 102 96 Q 120 90 138 96',
  emotionMouth: 'M 75 148 Q 100 155 125 148',
  mouthFill: 'transparent',
  cheekOpacity: 0,
  breathY: 0,
  headTiltDeg: 0,
  gazeX: 0,
  isNodding: false,
  nodProgress: 0,
  blinkState: false,
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseAvatarEngineReturn {
  state: AvatarEngineState
  prepareLipSync: (text: string) => void
  startLipSync: () => void
  stopLipSync: () => void
  setListening: (listening: boolean) => void
}

export function useAvatarEngine(
  emotion: AvatarEmotion,
  isTalking: boolean
): UseAvatarEngineReturn {
  const [state, setState] = useState<AvatarEngineState>(DEFAULT_STATE)

  // Engine refs (persist across renders)
  const lipSyncRef = useRef<LipSyncEngine | null>(null)
  const idleRef = useRef<IdleAnimationEngine | null>(null)
  const emotionRef = useRef<EmotionEngine | null>(null)

  // Mutable state collectors (avoid creating new objects every frame)
  const lipSyncState = useRef<string>(DEFAULT_STATE.mouthPath)
  const idleState = useRef<IdleState>({
    breathY: 0, headTiltDeg: 0, gazeX: 0,
    isNodding: false, nodProgress: 0, blinkState: false,
  })
  const emotionState = useRef<EmotionState>({
    leftBrow: DEFAULT_STATE.leftBrow,
    rightBrow: DEFAULT_STATE.rightBrow,
    mouth: DEFAULT_STATE.emotionMouth,
    mouthFill: DEFAULT_STATE.mouthFill,
    cheekOpacity: DEFAULT_STATE.cheekOpacity,
  })

  // Combine all engine states and push to React state
  // Use a throttled update to avoid excessive re-renders (~30fps is enough for SVG)
  const lastUpdateRef = useRef(0)
  const pendingRafRef = useRef<number | null>(null)

  const pushState = useCallback(() => {
    const now = performance.now()
    if (now - lastUpdateRef.current < 33) {
      // Throttle to ~30fps
      if (!pendingRafRef.current) {
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null
          pushState()
        })
      }
      return
    }
    lastUpdateRef.current = now

    const idle = idleState.current
    const emo = emotionState.current
    const lip = lipSyncState.current

    setState({
      mouthPath: lip,
      leftBrow: emo.leftBrow,
      rightBrow: emo.rightBrow,
      emotionMouth: emo.mouth,
      mouthFill: emo.mouthFill,
      cheekOpacity: emo.cheekOpacity,
      breathY: idle.breathY,
      headTiltDeg: idle.headTiltDeg,
      gazeX: idle.gazeX,
      isNodding: idle.isNodding,
      nodProgress: idle.nodProgress,
      blinkState: idle.blinkState,
    })
  }, [])

  // ── Initialize engines on mount ──
  useEffect(() => {
    const lipSync = new LipSyncEngine()
    const idle = new IdleAnimationEngine()
    const emotionEng = new EmotionEngine()

    lipSyncRef.current = lipSync
    idleRef.current = idle
    emotionRef.current = emotionEng

    // Start idle + emotion engines
    idle.start((s) => {
      idleState.current = s
      pushState()
    })

    emotionEng.start((s) => {
      emotionState.current = s
      pushState()
    })

    return () => {
      lipSync.stop()
      idle.stop()
      emotionEng.stop()
      if (pendingRafRef.current) cancelAnimationFrame(pendingRafRef.current)
    }
  }, [pushState])

  // ── Transition emotion on prop change ──
  useEffect(() => {
    emotionRef.current?.transitionTo(emotion)
  }, [emotion])

  // ── Lip sync controls ──
  const prepareLipSync = useCallback((text: string) => {
    lipSyncRef.current?.prepareFromText(text)
  }, [])

  const startLipSync = useCallback(() => {
    lipSyncRef.current?.start((mouthPath) => {
      lipSyncState.current = mouthPath
      pushState()
    })
  }, [pushState])

  const stopLipSync = useCallback(() => {
    lipSyncRef.current?.stop()
    lipSyncState.current = DEFAULT_STATE.mouthPath
    pushState()
  }, [pushState])

  // ── Listening mode for nods ──
  const setListening = useCallback((listening: boolean) => {
    idleRef.current?.setListening(listening)
  }, [])

  return { state, prepareLipSync, startLipSync, stopLipSync, setListening }
}
