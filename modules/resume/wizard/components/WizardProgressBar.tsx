'use client'

import { motion } from 'framer-motion'
import { WIZARD_STAGES } from '../config/wizardConfig'

interface Props {
  currentStage: number
  strengthScore: number
}

export default function WizardProgressBar({ currentStage, strengthScore }: Props) {
  return (
    <div className="w-full">
      {/* Progress steps */}
      <div className="flex items-center justify-between mb-2">
        {WIZARD_STAGES.map((stage, i) => {
          const isCompleted = i < currentStage
          const isCurrent = i === currentStage
          return (
            <div key={stage.id} className="flex items-center flex-1 last:flex-none">
              {/* Node */}
              <div className="flex flex-col items-center">
                <motion.div
                  className={`
                    w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold
                    transition-colors duration-200
                    ${isCompleted
                      ? 'bg-emerald-500 text-white'
                      : isCurrent
                        ? 'bg-[#6366f1] text-white ring-2 ring-[#6366f1]/30'
                        : 'bg-surface border border-[#e1e8ed] text-[#8b98a5]'
                    }
                  `}
                  initial={false}
                  animate={isCurrent ? { scale: [1, 1.1, 1] } : {}}
                  transition={{ duration: 0.3 }}
                >
                  {isCompleted ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i
                  )}
                </motion.div>
                <span className={`text-[9px] mt-1 hidden sm:block ${isCurrent ? 'text-[#6366f1] font-medium' : 'text-[#8b98a5]'}`}>
                  {stage.shortLabel}
                </span>
              </div>

              {/* Connector line */}
              {i < WIZARD_STAGES.length - 1 && (
                <div className="flex-1 h-0.5 mx-1 rounded-full overflow-hidden bg-surface">
                  <motion.div
                    className="h-full bg-emerald-500"
                    initial={false}
                    animate={{ width: isCompleted ? '100%' : '0%' }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Strength score badge */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[#8b98a5]">
          Stage {currentStage} of {WIZARD_STAGES.length - 1}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#8b98a5]">Strength</span>
          <div className="w-16 h-1.5 rounded-full bg-surface overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${
                strengthScore >= 75 ? 'bg-emerald-500'
                  : strengthScore >= 50 ? 'bg-amber-400'
                    : 'bg-[#6366f1]'
              }`}
              initial={false}
              animate={{ width: `${strengthScore}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <motion.span
            key={strengthScore}
            className={`text-xs font-bold ${
              strengthScore >= 75 ? 'text-[#059669]'
                : strengthScore >= 50 ? 'text-amber-400'
                  : 'text-[#6366f1]'
            }`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {strengthScore}
          </motion.span>
        </div>
      </div>
    </div>
  )
}
