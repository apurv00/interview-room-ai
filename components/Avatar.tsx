'use client'

import { useEffect, useRef } from 'react'
import type { AvatarEmotion } from '@/lib/types'
import { useAvatarEngine } from '@/hooks/useAvatarEngine'

interface AvatarProps {
  emotion: AvatarEmotion
  isTalking: boolean
  ttsText?: string
  isListening?: boolean
}

export default function Avatar({ emotion, isTalking, ttsText, isListening }: AvatarProps) {
  const { state, prepareLipSync, startLipSync, stopLipSync, setListening } = useAvatarEngine(emotion, isTalking)

  // Track previous talking state for start/stop transitions
  const prevTalkingRef = useRef(false)
  const prevTtsTextRef = useRef('')

  // Handle TTS text changes — prepare lip sync timeline
  useEffect(() => {
    if (ttsText && ttsText !== prevTtsTextRef.current) {
      prevTtsTextRef.current = ttsText
      prepareLipSync(ttsText)
    }
  }, [ttsText, prepareLipSync])

  // Handle talking state changes — start/stop lip sync
  useEffect(() => {
    if (isTalking && !prevTalkingRef.current) {
      startLipSync()
    } else if (!isTalking && prevTalkingRef.current) {
      stopLipSync()
    }
    prevTalkingRef.current = isTalking
  }, [isTalking, startLipSync, stopLipSync])

  // Handle listening mode for nods
  useEffect(() => {
    setListening(isListening ?? false)
  }, [isListening, setListening])

  // Choose mouth path: lip sync when talking, emotion mouth when idle
  const mouthPath = isTalking ? state.mouthPath : state.emotionMouth

  // Nod vertical offset
  const nodY = state.isNodding ? Math.sin(state.nodProgress * Math.PI) * 3 : 0

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-b from-slate-800 via-slate-850 to-slate-900 relative overflow-hidden">
      {/* Ambient background glow based on emotion */}
      <div
        className="absolute inset-0 transition-all duration-700"
        style={{
          background:
            emotion === 'impressed'
              ? 'radial-gradient(ellipse at 50% 80%, rgba(99,102,241,0.15), transparent 70%)'
              : emotion === 'skeptical'
              ? 'radial-gradient(ellipse at 50% 80%, rgba(239,68,68,0.08), transparent 70%)'
              : 'radial-gradient(ellipse at 50% 80%, rgba(59,130,246,0.1), transparent 70%)',
        }}
      />

      {/* Desk / surface hint */}
      <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-slate-700/30 to-transparent" />

      {/* Avatar SVG */}
      <svg
        viewBox="0 0 200 210"
        className="w-full h-full max-w-xs mx-auto"
        style={{ filter: 'drop-shadow(0 8px 32px rgba(0,0,0,0.5))' }}
      >
        {/* ── Clothing / body ── */}
        <ellipse cx="100" cy="218" rx="85" ry="50" fill="#1e3a5f" />
        {/* Collar / shirt */}
        <path d="M 82 190 L 100 205 L 118 190 L 114 178 L 86 178 Z" fill="#f1f5f9" />
        {/* Lapels */}
        <path d="M 86 178 L 100 205 L 82 190 Z" fill="#1d4ed8" />
        <path d="M 114 178 L 100 205 L 118 190 Z" fill="#1d4ed8" />
        {/* Jacket body */}
        <path
          d="M 20 220 Q 40 185 82 178 L 86 178 L 100 205 L 114 178 L 118 190 Q 160 185 180 220"
          fill="#1e40af"
        />

        {/* ── Head group with idle animations (breathing + tilt + nod) ── */}
        <g
          transform={`translate(0, ${state.breathY + nodY}) rotate(${state.headTiltDeg}, 100, 115)`}
        >
          {/* ── Neck ── */}
          <rect x="87" y="162" width="26" height="22" rx="5" fill="#d4956a" />

          {/* ── Head ── */}
          <ellipse cx="100" cy="115" rx="60" ry="65" fill="#d4956a" />

          {/* ── Hair ── */}
          <ellipse cx="100" cy="60" rx="60" ry="32" fill="#1a0a00" />
          <rect x="40" y="60" width="120" height="22" fill="#1a0a00" />
          {/* Side hair / temple */}
          <ellipse cx="42" cy="105" rx="9" ry="25" fill="#1a0a00" />
          <ellipse cx="158" cy="105" rx="9" ry="25" fill="#1a0a00" />

          {/* ── Ears ── */}
          <ellipse cx="40" cy="115" rx="9" ry="12" fill="#c07850" />
          <ellipse cx="160" cy="115" rx="9" ry="12" fill="#c07850" />

          {/* ── Eyes white ── */}
          <ellipse
            cx="78"
            cy="108"
            rx="15"
            ry={state.blinkState ? 1.5 : 12}
            fill="white"
            style={{ transition: 'ry 80ms' }}
          />
          <ellipse
            cx="122"
            cy="108"
            rx="15"
            ry={state.blinkState ? 1.5 : 12}
            fill="white"
            style={{ transition: 'ry 80ms' }}
          />

          {/* ── Iris + pupil (with gaze drift) ── */}
          {!state.blinkState && (
            <>
              <circle cx={79 + state.gazeX} cy="109" r="8" fill="#3b2a1a" />
              <circle cx={123 + state.gazeX} cy="109" r="8" fill="#3b2a1a" />
              <circle cx={79 + state.gazeX} cy="109" r="5" fill="#1a0a00" />
              <circle cx={123 + state.gazeX} cy="109" r="5" fill="#1a0a00" />
              {/* Catchlight */}
              <circle cx={81 + state.gazeX} cy="107" r="2" fill="white" opacity="0.8" />
              <circle cx={125 + state.gazeX} cy="107" r="2" fill="white" opacity="0.8" />
            </>
          )}

          {/* ── Eyebrows (from emotion engine) ── */}
          <path
            d={state.leftBrow}
            fill="none"
            stroke="#1a0a00"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <path
            d={state.rightBrow}
            fill="none"
            stroke="#1a0a00"
            strokeWidth="3.5"
            strokeLinecap="round"
          />

          {/* ── Nose ── */}
          <path d="M 100 118 L 95 138 Q 100 141 105 138 Z" fill="#b8714a" opacity="0.5" />
          <ellipse cx="95" cy="138" rx="5.5" ry="4" fill="#b8714a" opacity="0.4" />
          <ellipse cx="105" cy="138" rx="5.5" ry="4" fill="#b8714a" opacity="0.4" />

          {/* ── Mouth (lip sync when talking, emotion engine when idle) ── */}
          <path
            d={mouthPath}
            fill={isTalking ? 'rgba(30,10,5,0.8)' : state.mouthFill}
            stroke="#a0604a"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Upper lip line when talking */}
          {isTalking && (
            <path
              d="M 82 148 Q 100 143 118 148"
              fill="none"
              stroke="#a0604a"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}

          {/* ── Smile cheeks (opacity from emotion engine) ── */}
          {state.cheekOpacity > 0 && (
            <>
              <ellipse cx="65" cy="138" rx="10" ry="6" fill="#e88080" opacity={state.cheekOpacity} />
              <ellipse cx="135" cy="138" rx="10" ry="6" fill="#e88080" opacity={state.cheekOpacity} />
            </>
          )}
        </g>
      </svg>

      {/* Talking indicator pulse ring */}
      {isTalking && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="w-1 bg-indigo-400 rounded-full animate-pulse"
              style={{
                height: `${6 + Math.sin(i * 1.2) * 6}px`,
                animationDelay: `${i * 100}ms`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
