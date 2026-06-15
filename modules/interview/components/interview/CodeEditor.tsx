'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Send, ChevronDown, RotateCcw, Copy, Check, Play, Loader2, X } from 'lucide-react'
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
  /**
   * Whether the interview is actually ready to receive a submission. The parent
   * sets this false while the interviewer is still presenting the problem
   * (ASK_QUESTION) — submitting then is silently dropped by the interview loop,
   * so Submit must stay disabled until the editing phase. Defaults to true.
   */
  canSubmit?: boolean
}

export default function CodeEditor({
  initialCode = '',
  language,
  onLanguageChange,
  onSubmit,
  disabled = false,
  canSubmit = true,
}: CodeEditorProps) {
  const [code, setCode] = useState(initialCode ?? '')
  const [showLangDropdown, setShowLangDropdown] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lineCount, setLineCount] = useState(1)
  // #3 — once submitted, lock Submit (show "Submitted") until the candidate
  // edits the code again, so a stray click can't double-submit. A ref mirrors it
  // for the Monaco Ctrl+Enter action, whose closure is captured at mount.
  const [submitted, setSubmitted] = useState(false)
  const submittedRef = useRef(false)
  // #4 — Run code against the sandbox (/api/code/run) without submitting.
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  const themeDefinedRef = useRef(false)
  const prevLanguageRef = useRef(language)
  // Latest canSubmit for the Monaco Ctrl+Enter action (mount-time closure).
  const canSubmitRef = useRef(canSubmit)
  canSubmitRef.current = canSubmit

  const currentLang = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0]

  const markSubmitted = useCallback((value: boolean) => {
    submittedRef.current = value
    setSubmitted(value)
  }, [])

  // Reset editor contents when the user switches language (new starter code)
  // or when the parent swaps the underlying problem.
  useEffect(() => {
    if (prevLanguageRef.current !== language) {
      setCode(initialCode ?? '')
      prevLanguageRef.current = language
      // New language/problem → fresh submission + clear stale run output.
      markSubmitted(false)
      setRunResult(null)
      setShowOutput(false)
    }
  }, [language, initialCode, markSubmitted])

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
    // canSubmit guards against submitting before the interview installs its
    // submission resolver (early clicks are otherwise dropped, yet would lock
    // the button as "Submitted" — Codex P2).
    if (disabled || submittedRef.current || !canSubmit) return
    markSubmitted(true)
    onSubmit(code)
  }, [code, disabled, canSubmit, onSubmit, markSubmitted])

  // #4 — execute the current code in the sandbox and show stdout/stderr inline,
  // so candidates can test before committing to a Submit.
  const handleRun = useCallback(async () => {
    if (running || disabled) return
    setRunning(true)
    setShowOutput(true)
    setRunResult(null)
    try {
      const res = await fetch('/api/code/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRunResult({ stdout: '', stderr: data?.error || `Runner error (${res.status})`, exitCode: 1 })
      } else {
        setRunResult({
          stdout: typeof data.stdout === 'string' ? data.stdout : '',
          stderr: typeof data.stderr === 'string' ? data.stderr : '',
          exitCode: typeof data.exitCode === 'number' ? data.exitCode : 0,
        })
      }
    } catch {
      setRunResult({ stdout: '', stderr: 'Could not reach the code runner. Check your connection and try again.', exitCode: 1 })
    } finally {
      setRunning(false)
    }
  }, [code, language, running, disabled])

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
        if (disabled || submittedRef.current || !canSubmitRef.current) return
        markSubmitted(true)
        onSubmit(editor.getValue())
      },
    })
  }, [disabled, onSubmit, markSubmitted])

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
          {/* #4 — Run (test) before Submit */}
          <button
            onClick={handleRun}
            disabled={disabled || running}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-100 bg-gray-700/80 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded-md transition-all"
            title="Run code without submitting"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Running' : 'Run'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={disabled || submitted || !canSubmit}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-all shadow-sm hover:shadow-emerald-500/20"
            title={
              submitted
                ? 'Already submitted — edit your code to submit again'
                : !canSubmit
                  ? 'Wait until the interviewer finishes presenting the problem'
                  : 'Submit code (Ctrl+Enter)'
            }
          >
            {submitted ? <Check className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
            {submitted ? 'Submitted' : 'Submit'}
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
          onChange={(value) => {
            setCode(value ?? '')
            // Editing after a submit re-arms Submit (#3).
            if (submittedRef.current) markSubmitted(false)
          }}
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

      {/* #4 — Run output panel */}
      {showOutput && (
        <div className="shrink-0 max-h-[35%] flex flex-col bg-[#15161f] border-t border-gray-700/50">
          <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-700/40">
            <div className="flex items-center gap-2 text-xs font-medium text-gray-300">
              <span>Output</span>
              {/* The Run button predicts output with the model, not a real sandbox. */}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-300" title="Output is predicted by AI, not a sandboxed execution — it can differ from a real run.">
                AI-estimated
              </span>
              {runResult && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    runResult.exitCode === 0
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-red-500/20 text-red-300'
                  }`}
                >
                  exit {runResult.exitCode}
                </span>
              )}
            </div>
            <button
              onClick={() => setShowOutput(false)}
              className="text-gray-500 hover:text-white transition-colors"
              title="Close output"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs leading-relaxed">
            {running ? (
              <span className="text-gray-400 inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…
              </span>
            ) : runResult ? (
              <>
                {runResult.stdout && (
                  <pre className="text-gray-100 whitespace-pre-wrap break-words">{runResult.stdout}</pre>
                )}
                {runResult.stderr && (
                  <pre className="text-red-400 whitespace-pre-wrap break-words">{runResult.stderr}</pre>
                )}
                {!runResult.stdout && !runResult.stderr && (
                  <span className="text-gray-500">No output.</span>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

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
