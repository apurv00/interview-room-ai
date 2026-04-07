import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CodeLanguage } from '@shared/types'

// Mock next/dynamic so MonacoEditor renders synchronously as a stub.
// This avoids loading the real Monaco bundle in jsdom and lets us assert
// on the props the parent passes through (value/language).
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => {
    const Stub = (props: { value?: string; language?: string }) => (
      <div
        data-testid="monaco-stub"
        data-value={props.value ?? ''}
        data-language={props.language ?? ''}
      />
    )
    Stub.displayName = 'MonacoStub'
    return Stub
  },
}))

import CodeEditor from '../components/interview/CodeEditor'

describe('CodeEditor language switching', () => {
  function renderEditor(initial: { language: CodeLanguage; initialCode: string }) {
    const onLanguageChange = vi.fn()
    const onSubmit = vi.fn()
    const utils = render(
      <CodeEditor
        initialCode={initial.initialCode}
        language={initial.language}
        onLanguageChange={onLanguageChange}
        onSubmit={onSubmit}
      />
    )
    return { ...utils, onLanguageChange, onSubmit }
  }

  it('renders with initial language and starter code', () => {
    renderEditor({ language: 'python', initialCode: 'def two_sum(): pass' })
    const stub = screen.getByTestId('monaco-stub')
    expect(stub.getAttribute('data-language')).toBe('python')
    expect(stub.getAttribute('data-value')).toBe('def two_sum(): pass')
  })

  it('does not crash when switching language and resets to new starter code', () => {
    const { rerender, onLanguageChange } = renderEditor({
      language: 'python',
      initialCode: 'def two_sum(): pass',
    })

    // Open the language dropdown and pick Java
    fireEvent.click(screen.getByRole('button', { name: /python/i }))
    fireEvent.click(screen.getByRole('button', { name: /java$/i }))
    expect(onLanguageChange).toHaveBeenCalledWith('java')

    // Parent re-renders with the new language and the new starter code
    expect(() =>
      rerender(
        <CodeEditor
          initialCode={'class Solution { }'}
          language={'java'}
          onLanguageChange={onLanguageChange}
          onSubmit={vi.fn()}
        />
      )
    ).not.toThrow()

    const stub = screen.getByTestId('monaco-stub')
    expect(stub.getAttribute('data-language')).toBe('java')
    expect(stub.getAttribute('data-value')).toBe('class Solution { }')
  })

  it('falls back to empty string when starter code is undefined for a language', () => {
    const { rerender, onLanguageChange } = renderEditor({
      language: 'python',
      initialCode: 'def two_sum(): pass',
    })

    // Switch to a language whose starter code is missing (parent passes '')
    expect(() =>
      rerender(
        <CodeEditor
          initialCode={''}
          language={'cpp'}
          onLanguageChange={onLanguageChange}
          onSubmit={vi.fn()}
        />
      )
    ).not.toThrow()

    const stub = screen.getByTestId('monaco-stub')
    expect(stub.getAttribute('data-language')).toBe('cpp')
    expect(stub.getAttribute('data-value')).toBe('')
  })

  it('survives a language switch even if onLanguageChange throws', () => {
    const throwingHandler = vi.fn(() => {
      throw new Error('boom')
    })
    render(
      <CodeEditor
        initialCode="x = 1"
        language="python"
        onLanguageChange={throwingHandler}
        onSubmit={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /python/i }))
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /typescript/i }))
    ).not.toThrow()
    expect(throwingHandler).toHaveBeenCalledWith('typescript')
  })
})
