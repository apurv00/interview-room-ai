'use client'

import { useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { Play, Send, ChevronDown } from 'lucide-react'
import type { CodeLanguage } from '@shared/types'

// Lazy-load Monaco to avoid SSR issues and reduce initial bundle
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

const LANGUAGES: Array<{ value: CodeLanguage; label: string; monacoId: string }> = [
  { value: 'python', label: 'Python', monacoId: 'python' },
  { value: 'javascript', label: 'JavaScript', monacoId: 'javascript' },
  { value: 'typescript', label: 'TypeScript', monacoId: 'typescript' },
  { value: 'java', label: 'Java', monacoId: 'java' },
  { value: 'cpp', label: 'C++', monacoId: 'cpp' },
]

interface CodeEditorProps {
  initialCode?: string
  language: CodeLanguage
  onLanguageChange: (lang: CodeLanguage) => void
  onSubmit: (code: string) => void
  disabled?: boolean
}

export default function CodeEditor({
  initialCode = '',
  language,
  onLanguageChange,
  onSubmit,
  disabled = false,
}: CodeEditorProps) {
  const [code, setCode] = useState(initialCode)
  const [showLangDropdown, setShowLangDropdown] = useState(false)

  const currentLang = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0]

  const handleSubmit = useCallback(() => {
    if (!disabled) onSubmit(code)
  }, [code, disabled, onSubmit])

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-gray-700">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-900 border-b border-gray-700">
        {/* Language selector */}
        <div className="relative">
          <button
            onClick={() => setShowLangDropdown(!showLangDropdown)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 rounded-md hover:bg-gray-700 transition-colors"
          >
            {currentLang.label}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showLangDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-lg z-20">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => {
                    onLanguageChange(lang.value)
                    setShowLangDropdown(false)
                  }}
                  className={`block w-full text-left px-4 py-2 text-xs hover:bg-gray-700 transition-colors ${
                    lang.value === language ? 'text-blue-400' : 'text-gray-300'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={disabled}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-colors"
          >
            <Send className="w-3 h-3" />
            Submit
          </button>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 min-h-0">
        <MonacoEditor
          height="100%"
          language={currentLang.monacoId}
          value={code}
          onChange={(value) => setCode(value || '')}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 12 },
            readOnly: disabled,
          }}
        />
      </div>
    </div>
  )
}
