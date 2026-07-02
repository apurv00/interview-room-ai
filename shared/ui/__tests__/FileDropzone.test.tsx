// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FileDropzone from '@shared/ui/FileDropzone'

afterEach(cleanup)

function renderDropzone(overrides: Partial<React.ComponentProps<typeof FileDropzone>> = {}) {
  const onFileSelect = vi.fn()
  const onError = vi.fn()
  render(
    <FileDropzone
      label="Upload Resume"
      isUploading={false}
      onFileSelect={onFileSelect}
      onRemove={() => {}}
      onError={onError}
      {...overrides}
    />,
  )
  return { onFileSelect, onError }
}

describe('FileDropzone keyboard accessibility', () => {
  it('exposes the drop area as a focusable button', () => {
    renderDropzone()
    const zone = screen.getByRole('button', { name: /upload resume/i })
    expect(zone).toBeTruthy()
    expect(zone.getAttribute('tabindex')).toBe('0')
  })

  it('opens the file picker on Enter and Space', () => {
    renderDropzone()
    const zone = screen.getByRole('button', { name: /upload resume/i })
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(zone, { key: ' ' })
    expect(clickSpy).toHaveBeenCalledTimes(2)
  })

  it('does not open the picker on unrelated keys', () => {
    renderDropzone()
    const zone = screen.getByRole('button', { name: /upload resume/i })
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')
    fireEvent.keyDown(zone, { key: 'Tab' })
    fireEvent.keyDown(zone, { key: 'a' })
    expect(clickSpy).not.toHaveBeenCalled()
  })
})

describe('FileDropzone validation (unchanged behavior)', () => {
  it('rejects a dropped file with a disallowed extension', () => {
    const { onFileSelect, onError } = renderDropzone()
    const zone = screen.getByRole('button', { name: /upload resume/i })
    const file = new File(['x'], 'resume.rtf', { type: 'application/rtf' })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFileSelect).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('.rtf'))
  })

  it('accepts a dropped file with an allowed extension', () => {
    const { onFileSelect, onError } = renderDropzone()
    const zone = screen.getByRole('button', { name: /upload resume/i })
    const file = new File(['x'], 'resume.pdf', { type: 'application/pdf' })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(onFileSelect).toHaveBeenCalledWith(file)
    expect(onError).not.toHaveBeenCalled()
  })
})
