'use client'

import { useCallback, useRef, useState } from 'react'
import { CheckCircle2, Upload } from 'lucide-react'

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
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-emerald-600 font-medium truncate">{fileName}</p>
          <p className="text-xs text-slate-500">{label}</p>
        </div>
        <button
          onClick={onRemove}
          className="text-xs text-slate-500 hover:text-[#f4212e] transition shrink-0"
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
          : 'border-slate-200 hover:border-slate-400 bg-white hover:bg-slate-50'
        }
      `}
    >
      <Upload className="w-6 h-6 text-slate-400" strokeWidth={1.5} />
      <p className="text-sm text-slate-500 font-medium">{label}</p>
      <p className="text-xs text-slate-400">PDF, DOCX, or TXT</p>
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
