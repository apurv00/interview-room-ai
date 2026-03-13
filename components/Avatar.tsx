'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AvatarEmotion } from '@shared/types'
import { useAvatarEngine } from '@/hooks/useAvatarEngine'

interface AvatarProps {
  emotion: AvatarEmotion
  isTalking: boolean
  ttsText?: string
  isListening?: boolean
  isProcessing?: boolean
}

// Ambient glow colors per emotion
const GLOW_COLORS: Record<AvatarEmotion, string> = {
  neutral: 'rgba(99,102,241,0.08)',
  friendly: 'rgba(59,130,246,0.12)',
  curious: 'rgba(168,85,247,0.10)',
  skeptical: 'rgba(239,68,68,0.07)',
  impressed: 'rgba(16,185,129,0.12)',
}

export default function Avatar({ emotion, isTalking, ttsText, isListening, isProcessing }: AvatarProps) {
  const { state, prepareLipSync, startLipSync, stopLipSync, setListening } = useAvatarEngine(emotion, isTalking)

  const prevTalkingRef = useRef(false)
  const prevTtsTextRef = useRef('')

  useEffect(() => {
    if (ttsText && ttsText !== prevTtsTextRef.current) {
      prevTtsTextRef.current = ttsText
      prepareLipSync(ttsText)
    }
  }, [ttsText, prepareLipSync])

  useEffect(() => {
    if (isTalking && !prevTalkingRef.current) {
      startLipSync()
    } else if (!isTalking && prevTalkingRef.current) {
      stopLipSync()
    }
    prevTalkingRef.current = isTalking
  }, [isTalking, startLipSync, stopLipSync])

  useEffect(() => {
    setListening(isListening ?? false)
  }, [isListening, setListening])

  const mouthPath = isTalking ? state.mouthPath : state.emotionMouth
  const nodY = state.isNodding ? Math.sin(state.nodProgress * Math.PI) * 3 : 0

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-b from-slate-800 via-[#0f1729] to-slate-900 relative overflow-hidden">
      {/* Ambient background glow — crossfades with emotion */}
      <motion.div
        className="absolute inset-0"
        animate={{
          background: `radial-gradient(ellipse at 50% 75%, ${GLOW_COLORS[emotion]}, transparent 70%)`,
        }}
        transition={{ duration: 0.8, ease: 'easeInOut' }}
      />

      {/* Subtle background grid for depth */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.4) 1px, transparent 0)',
          backgroundSize: '24px 24px',
        }}
      />

      {/* Active state ring (listening = green, talking = indigo) */}
      <AnimatePresence>
        {(isTalking || isListening) && (
          <motion.div
            key="active-ring"
            className="absolute inset-4 rounded-full pointer-events-none"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{
              opacity: [0.15, 0.3, 0.15],
              scale: [0.98, 1, 0.98],
            }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{
              opacity: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
              scale: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
            }}
            style={{
              border: `2px solid ${isListening ? 'rgba(16,185,129,0.5)' : 'rgba(99,102,241,0.5)'}`,
              boxShadow: `0 0 40px ${isListening ? 'rgba(16,185,129,0.1)' : 'rgba(99,102,241,0.1)'}`,
            }}
          />
        )}
      </AnimatePresence>

      {/* Desk / surface hint */}
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-slate-700/20 to-transparent" />

      {/* Avatar SVG */}
      <svg
        viewBox="0 0 200 210"
        className="w-full h-full max-w-xs mx-auto relative z-10"
        style={{ filter: 'drop-shadow(0 8px 32px rgba(0,0,0,0.5))' }}
      >
        {/* ── Clothing / body ── */}
        <ellipse cx="100" cy="218" rx="85" ry="50" fill="#1e3a5f" />
        <path d="M 82 190 L 100 205 L 118 190 L 114 178 L 86 178 Z" fill="#f1f5f9" />
        <path d="M 86 178 L 100 205 L 82 190 Z" fill="#1d4ed8" />
        <path d="M 114 178 L 100 205 L 118 190 Z" fill="#1d4ed8" />
        <path
          d="M 20 220 Q 40 185 82 178 L 86 178 L 100 205 L 114 178 L 118 190 Q 160 185 180 220"
          fill="#1e40af"
        />

        {/* ── Head group with idle animations ── */}
        <g transform={`translate(0, ${state.breathY + nodY}) rotate(${state.headTiltDeg}, 100, 115)`}>
          <rect x="87" y="162" width="26" height="22" rx="5" fill="#d4956a" />
          <ellipse cx="100" cy="115" rx="60" ry="65" fill="#d4956a" />

          {/* Hair */}
          <ellipse cx="100" cy="60" rx="60" ry="32" fill="#1a0a00" />
          <rect x="40" y="60" width="120" height="22" fill="#1a0a00" />
          <ellipse cx="42" cy="105" rx="9" ry="25" fill="#1a0a00" />
          <ellipse cx="158" cy="105" rx="9" ry="25" fill="#1a0a00" />

          {/* Ears */}
          <ellipse cx="40" cy="115" rx="9" ry="12" fill="#c07850" />
          <ellipse cx="160" cy="115" rx="9" ry="12" fill="#c07850" />

          {/* Eyes */}
          <ellipse cx="78" cy="108" rx="15" ry={state.blinkState ? 1.5 : 12} fill="white"
            style={{ transition: 'ry 80ms' }} />
          <ellipse cx="122" cy="108" rx="15" ry={state.blinkState ? 1.5 : 12} fill="white"
            style={{ transition: 'ry 80ms' }} />

          {/* Iris + pupil with gaze */}
          {!state.blinkState && (
            <>
              <circle cx={79 + state.gazeX} cy="109" r="8" fill="#3b2a1a" />
              <circle cx={123 + state.gazeX} cy="109" r="8" fill="#3b2a1a" />
              <circle cx={79 + state.gazeX} cy="109" r="5" fill="#1a0a00" />
              <circle cx={123 + state.gazeX} cy="109" r="5" fill="#1a0a00" />
              <circle cx={81 + state.gazeX} cy="107" r="2" fill="white" opacity="0.8" />
              <circle cx={125 + state.gazeX} cy="107" r="2" fill="white" opacity="0.8" />
            </>
          )}

          {/* Eyebrows */}
          <path d={state.leftBrow} fill="none" stroke="#1a0a00" strokeWidth="3.5" strokeLinecap="round" />
          <path d={state.rightBrow} fill="none" stroke="#1a0a00" strokeWidth="3.5" strokeLinecap="round" />

          {/* Nose */}
          <path d="M 100 118 L 95 138 Q 100 141 105 138 Z" fill="#b8714a" opacity="0.5" />
          <ellipse cx="95" cy="138" rx="5.5" ry="4" fill="#b8714a" opacity="0.4" />
          <ellipse cx="105" cy="138" rx="5.5" ry="4" fill="#b8714a" opacity="0.4" />

          {/* Mouth */}
          <path
            d={mouthPath}
            fill={isTalking ? 'rgba(30,10,5,0.8)' : state.mouthFill}
            stroke="#a0604a"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {isTalking && (
            <path d="M 82 148 Q 100 143 118 148" fill="none" stroke="#a0604a" strokeWidth="2" strokeLinecap="round" />
          )}

          {/* Cheeks */}
          {state.cheekOpacity > 0 && (
            <>
              <ellipse cx="65" cy="138" rx="10" ry="6" fill="#e88080" opacity={state.cheekOpacity} />
              <ellipse cx="135" cy="138" rx="10" ry="6" fill="#e88080" opacity={state.cheekOpacity} />
            </>
          )}
        </g>
      </svg>

      {/* Bottom status indicator */}
      <AnimatePresence mode="wait">
        {isTalking && (
          <motion.div
            key="talking-indicator"
            className="absolute bottom-5 left-1/2 flex items-center gap-1.5"
            initial={{ opacity: 0, y: 8, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 4, x: '-50%' }}
            transition={{ duration: 0.25 }}
          >
            <div className="flex items-end gap-[3px] h-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  className="w-[3px] bg-indigo-400 rounded-full origin-bottom"
                  animate={{
                    scaleY: [0.3, 1, 0.3],
                  }}
                  transition={{
                    duration: 0.6,
                    repeat: Infinity,
                    delay: i * 0.08,
                    ease: 'easeInOut',
                  }}
                  style={{ height: '16px' }}
                />
              ))}
            </div>
            <span className="text-[10px] text-indigo-300/70 font-medium ml-1.5 uppercase tracking-wider">
              Speaking
            </span>
          </motion.div>
        )}

        {isListening && !isTalking && (
          <motion.div
            key="listening-indicator"
            className="absolute bottom-5 left-1/2 flex items-center gap-2"
            initial={{ opacity: 0, y: 8, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 4, x: '-50%' }}
            transition={{ duration: 0.25 }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-emerald-400"
              animate={{ scale: [1, 1.3, 1], opacity: [0.6, 1, 0.6] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            />
            <span className="text-[10px] text-emerald-300/70 font-medium uppercase tracking-wider">
              Listening
            </span>
          </motion.div>
        )}

        {isProcessing && !isTalking && !isListening && (
          <motion.div
            key="processing-indicator"
            className="absolute bottom-5 left-1/2 flex items-center gap-1.5"
            initial={{ opacity: 0, y: 8, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 4, x: '-50%' }}
            transition={{ duration: 0.25 }}
          >
            <div className="flex items-center gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-amber-400"
                  animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                  transition={{
                    duration: 0.8,
                    repeat: Infinity,
                    delay: i * 0.15,
                    ease: 'easeInOut',
                  }}
                />
              ))}
            </div>
            <span className="text-[10px] text-amber-300/70 font-medium ml-1 uppercase tracking-wider">
              Thinking
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
