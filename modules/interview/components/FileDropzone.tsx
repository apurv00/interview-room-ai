'use client'

import { useCallback, useRef, useState } from 'react'

interface FileDropzoneProps {
  label: string
  fileName?: string
  isUploading: boolean
  onFileSelect: (file: File) => void
  onRemove: () => void
  accept?: string
  maxSizeMB?: number
  onError?: (message: string) => void
}

export default function FileDropzone({
  label,
  fileName,
  isUploading,
  onFileSelect,
  onRemove,
  accept = '.pdf,.docx,.txt',
  maxSizeMB = 10,
  onError,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const validateAndSelect = useCallback(
    (file: File) => {
      if (file.size > maxSizeMB * 1024 * 1024) {
        onError?.(`File too large. Maximum size is ${maxSizeMB}MB.`)
        return
      }
      onFileSelect(file)
    },
    [onFileSelect, maxSizeMB, onError]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) validateAndSelect(file)
    },
    [validateAndSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) validateAndSelect(file)
    },
    [validateAndSelect]
  )

  // Uploading state
  if (isUploading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-6 px-4 rounded-xl border-2 border-dashed border-blue-500/30 bg-blue-500/5">
        <div className="w-5 h-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
        <p className="text-xs text-blue-600">Parsing...</p>
      </div>
    )
  }

  // Uploaded state
  if (fileName) {
    return (
      <div className="flex items-center gap-3 py-4 px-4 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
        <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-emerald-600 font-medium truncate">{fileName}</p>
          <p className="text-xs text-[#71767b]">{label}</p>
        </div>
        <button
          onClick={onRemove}
          className="text-xs text-[#71767b] hover:text-[#f4212e] transition shrink-0"
        >
          Remove
        </button>
      </div>
    )
  }

  // Empty state — drag & drop
  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
      className={`
        flex flex-col items-center justify-center gap-2 py-6 px-4 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200
        ${isDragging
          ? 'border-blue-600 bg-blue-500/10'
          : 'border-[#e1e8ed] hover:border-[#536471] bg-white hover:bg-[#f7f9f9]'
        }
      `}
    >
      <svg className="w-6 h-6 text-[#71767b]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
      </svg>
      <p className="text-sm text-[#536471] font-medium">{label}</p>
      <p className="text-xs text-[#8b98a5]">PDF, DOCX, or TXT</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
      />
    </div>
  )
}
