'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Send, ChevronDown, RotateCcw, Copy, Check } from 'lucide-react'
import type { CodeLanguage } from '@shared/types'
import type { editor as MonacoEditorType } from 'monaco-editor'

// Lazy-load Monaco to avoid SSR issues and reduce initial bundle
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

const LANGUAGES: Array<{ value: CodeLanguage; label: string; monacoId: string; icon: string }> = [
  { value: 'python', label: 'Python', monacoId: 'python', icon: '🐍' },
  { value: 'javascript', label: 'JavaScript', monacoId: 'javascript', icon: 'JS' },
  { value: 'typescript', label: 'TypeScript', monacoId: 'typescript', icon: 'TS' },
  { value: 'java', label: 'Java', monacoId: 'java', icon: '☕' },
  { value: 'cpp', label: 'C++', monacoId: 'cpp', icon: '⚡' },
]

// ─── Custom Monokai-inspired theme for vivid syntax highlighting ────────────

function defineCustomTheme(monaco: typeof import('monaco-editor')) {
  monaco.editor.defineTheme('interview-monokai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Keywords (if, else, for, while, return, class, def, function, const, let, var)
      { token: 'keyword', foreground: 'F92672', fontStyle: 'bold' },       // Pink/magenta
      { token: 'keyword.control', foreground: 'F92672', fontStyle: 'bold' },

      // Strings
      { token: 'string', foreground: 'E6DB74' },                           // Yellow
      { token: 'string.escape', foreground: 'AE81FF' },

      // Numbers
      { token: 'number', foreground: 'AE81FF' },                           // Purple
      { token: 'number.float', foreground: 'AE81FF' },

      // Comments
      { token: 'comment', foreground: '75715E', fontStyle: 'italic' },     // Gray italic
      { token: 'comment.line', foreground: '75715E', fontStyle: 'italic' },
      { token: 'comment.block', foreground: '75715E', fontStyle: 'italic' },

      // Functions
      { token: 'entity.name.function', foreground: 'A6E22E' },             // Green
      { token: 'support.function', foreground: 'A6E22E' },
      { token: 'meta.function-call', foreground: 'A6E22E' },

      // Types and classes
      { token: 'entity.name.type', foreground: '66D9EF', fontStyle: 'italic' }, // Cyan
      { token: 'entity.name.class', foreground: 'A6E22E' },
      { token: 'support.type', foreground: '66D9EF' },
      { token: 'type', foreground: '66D9EF', fontStyle: 'italic' },
      { token: 'type.identifier', foreground: '66D9EF', fontStyle: 'italic' },

      // Variables and identifiers
      { token: 'variable', foreground: 'F8F8F2' },                         // White
      { token: 'variable.parameter', foreground: 'FD971F', fontStyle: 'italic' }, // Orange
      { token: 'variable.predefined', foreground: '66D9EF' },

      // Operators
      { token: 'operator', foreground: 'F92672' },                         // Pink
      { token: 'delimiter', foreground: 'F8F8F2' },
      { token: 'delimiter.bracket', foreground: 'F8F8F2' },

      // Decorators / annotations
      { token: 'tag', foreground: 'F92672' },
      { token: 'attribute.name', foreground: 'A6E22E' },
      { token: 'attribute.value', foreground: 'E6DB74' },

      // Python-specific
      { token: 'keyword.python', foreground: 'F92672', fontStyle: 'bold' },
      { token: 'identifier.python', foreground: 'F8F8F2' },

      // Regex
      { token: 'regexp', foreground: 'E6DB74' },

      // Constants
      { token: 'constant', foreground: 'AE81FF' },
      { token: 'constant.language', foreground: 'AE81FF' },                // true, false, null, None
    ],
    colors: {
      // Editor background & foreground
      'editor.background': '#1a1b26',                    // Deep navy (softer than pure black)
      'editor.foreground': '#F8F8F2',                    // Off-white text
      'editorCursor.foreground': '#F8F8F0',              // Bright cursor

      // Line highlighting
      'editor.lineHighlightBackground': '#2a2b3d',      // Subtle current line highlight
      'editor.lineHighlightBorder': '#2a2b3d',

      // Selection
      'editor.selectionBackground': '#49483E',           // Selection highlight
      'editor.inactiveSelectionBackground': '#3a3b4d',
      'editor.selectionHighlightBackground': '#49483E55',

      // Line numbers
      'editorLineNumber.foreground': '#5C6370',          // Muted line numbers
      'editorLineNumber.activeForeground': '#ABB2BF',    // Bright active line number

      // Indent guides
      'editorIndentGuide.background': '#3a3b4d',         // Visible indent guides
      'editorIndentGuide.activeBackground': '#5C6370',   // Brighter active indent guide

      // Bracket matching
      'editorBracketMatch.background': '#49483E',
      'editorBracketMatch.border': '#F92672',            // Pink bracket match border

      // Bracket pair colorization
      'editorBracketPairGuide.foreground1': '#F92672',   // Pink
      'editorBracketPairGuide.foreground2': '#A6E22E',   // Green
      'editorBracketPairGuide.foreground3': '#66D9EF',   // Cyan
      'editorBracketPairGuide.foreground4': '#E6DB74',   // Yellow
      'editorBracketPairGuide.foreground5': '#AE81FF',   // Purple
      'editorBracketPairGuide.foreground6': '#FD971F',   // Orange

      // Scrollbar
      'scrollbarSlider.background': '#3a3b4d80',
      'scrollbarSlider.hoverBackground': '#5C637080',
      'scrollbarSlider.activeBackground': '#ABB2BF40',

      // Widgets
      'editorWidget.background': '#21222C',
      'editorSuggestWidget.background': '#21222C',

      // Gutter
      'editorGutter.background': '#1a1b26',
    },
  })
}

// ─── Component ──────────────────────────────────────────────────────────────

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
  const [code, setCode] = useState(initialCode ?? '')
  const [showLangDropdown, setShowLangDropdown] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lineCount, setLineCount] = useState(1)
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  const themeDefinedRef = useRef(false)
  const prevLanguageRef = useRef(language)

  const currentLang = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0]

  // Reset editor contents when the user switches language (new starter code)
  // or when the parent swaps the underlying problem.
  useEffect(() => {
    if (prevLanguageRef.current !== language) {
      setCode(initialCode ?? '')
      prevLanguageRef.current = language
    }
  }, [language, initialCode])

  // First-time hydration of starter code if it loads after mount
  useEffect(() => {
    if (initialCode && !code) setCode(initialCode)
  }, [initialCode]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLanguageSelect = useCallback(
    (lang: CodeLanguage) => {
      try {
        onLanguageChange(lang)
      } catch (err) {
        // Defensive: never let a language switch leave the editor in a broken state
        console.error('[CodeEditor] language switch failed:', err)
      } finally {
        setShowLangDropdown(false)
      }
    },
    [onLanguageChange]
  )

  const handleSubmit = useCallback(() => {
    if (!disabled) onSubmit(code)
  }, [code, disabled, onSubmit])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [code])

  const handleReset = useCallback(() => {
    setCode(initialCode)
  }, [initialCode])

  const handleEditorMount = useCallback((editor: MonacoEditorType.IStandaloneCodeEditor) => {
    editorRef.current = editor

    // Focus editor on mount
    setTimeout(() => editor.focus(), 100)

    // Track line count
    const model = editor.getModel()
    if (model) {
      setLineCount(model.getLineCount())
      model.onDidChangeContent(() => {
        setLineCount(model.getLineCount())
      })
    }

    // Add keyboard shortcut: Ctrl+Enter to submit
    editor.addAction({
      id: 'submit-code',
      label: 'Submit Code',
      keybindings: [
        // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.Enter
        2048 | 3, // CtrlCmd + Enter
      ],
      run: () => {
        if (!disabled) onSubmit(editor.getValue())
      },
    })
  }, [disabled, onSubmit])

  const handleBeforeMount = useCallback((monaco: typeof import('monaco-editor')) => {
    if (!themeDefinedRef.current) {
      defineCustomTheme(monaco)
      themeDefinedRef.current = true
    }
  }, [])

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-gray-700/50 shadow-lg">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#1e1f2e] border-b border-gray-700/50">
        <div className="flex items-center gap-3">
          {/* Language selector */}
          <div className="relative">
            <button
              onClick={() => setShowLangDropdown(!showLangDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-200 bg-gray-800/80 rounded-md hover:bg-gray-700 transition-colors border border-gray-600/50"
            >
              <span className="text-xs">{currentLang.icon}</span>
              {currentLang.label}
              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            </button>
            {showLangDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#21222C] border border-gray-600/50 rounded-md shadow-xl z-20 min-w-[160px]">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.value}
                    onClick={() => handleLanguageSelect(lang.value)}
                    className={`flex items-center gap-2 w-full text-left px-4 py-2.5 text-sm hover:bg-gray-700/50 transition-colors ${
                      lang.value === language ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-200'
                    }`}
                  >
                    <span className="text-xs w-5 text-center">{lang.icon}</span>
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Line count & status */}
          <span className="text-xs text-gray-500 tabular-nums hidden sm:inline">
            {lineCount} lines
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700/50 rounded-md transition-colors"
            title="Copy code"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700/50 rounded-md transition-colors"
            title="Reset to starter code"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-5 bg-gray-700/50 mx-1" />
          <button
            onClick={handleSubmit}
            disabled={disabled}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-all shadow-sm hover:shadow-emerald-500/20"
            title="Submit code (Ctrl+Enter)"
          >
            <Send className="w-3.5 h-3.5" />
            Submit
          </button>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 min-h-0">
        <MonacoEditor
          key={currentLang.value}
          height="100%"
          language={currentLang.monacoId}
          value={code ?? ''}
          onChange={(value) => setCode(value ?? '')}
          theme="interview-monokai"
          beforeMount={handleBeforeMount}
          onMount={handleEditorMount}
          options={{
            // ─── Font & Display ──
            fontSize: 15,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Monaco', monospace",
            fontLigatures: true,
            lineHeight: 22,
            letterSpacing: 0.3,

            // ─── Line Numbers & Gutter ──
            lineNumbers: 'on',
            glyphMargin: false,
            folding: true,
            foldingHighlight: true,
            lineDecorationsWidth: 8,
            lineNumbersMinChars: 3,

            // ─── Indentation & Formatting ──
            tabSize: language === 'python' ? 4 : 2,
            insertSpaces: true,
            autoIndent: 'full',
            formatOnPaste: true,
            formatOnType: true,
            detectIndentation: true,

            // ─── Brackets & Guides ──
            bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
            guides: {
              indentation: true,
              bracketPairs: true,
              bracketPairsHorizontal: true,
              highlightActiveBracketPair: true,
              highlightActiveIndentation: true,
            },
            matchBrackets: 'always',

            // ─── Auto-Complete & Suggestions ──
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            autoSurround: 'languageDefined',
            suggestOnTriggerCharacters: true,
            quickSuggestions: { other: true, comments: false, strings: false },
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            parameterHints: { enabled: true },

            // ─── Cursor & Selection ──
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            cursorWidth: 2,
            renderLineHighlight: 'all',
            renderLineHighlightOnlyWhenFocus: false,

            // ─── Scrolling ──
            smoothScrolling: true,
            scrollBeyondLastLine: false,
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
              verticalSliderSize: 6,
            },

            // ─── Wrapping ──
            wordWrap: 'on',
            wrappingIndent: 'indent',

            // ─── Layout ──
            automaticLayout: true,
            padding: { top: 16, bottom: 16 },
            minimap: { enabled: false },

            // ─── Misc ──
            readOnly: disabled,
            domReadOnly: disabled,
            renderWhitespace: 'selection',
            colorDecorators: true,
            linkedEditing: true,
            stickyScroll: { enabled: false },
          }}
        />
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#1e1f2e] border-t border-gray-700/50 text-[11px] text-gray-500">
        <div className="flex items-center gap-3">
          <span>{currentLang.label}</span>
          <span>Tab Size: {language === 'python' ? 4 : 2}</span>
          <span>UTF-8</span>
        </div>
        <div className="flex items-center gap-3">
          {disabled && <span className="text-amber-500">Read Only</span>}
          <span className="tabular-nums">{lineCount} lines</span>
          <span>Ctrl+Enter to submit</span>
        </div>
      </div>
    </div>
  )
}
