'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser, Undo2, Trash2, Pen } from 'lucide-react'

interface WhiteboardCanvasProps {
  className?: string
}

type Tool = 'pen' | 'eraser'

interface Point {
  x: number
  y: number
}

interface Stroke {
  points: Point[]
  color: string
  width: number
  tool: Tool
}

const COLORS = ['#ffffff', '#60a5fa', '#f87171', '#4ade80', '#facc15', '#c084fc']
const PEN_WIDTH = 2
const ERASER_WIDTH = 20

export default function WhiteboardCanvas({ className }: WhiteboardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ffffff')
  const [isDrawing, setIsDrawing] = useState(false)
  const strokesRef = useRef<Stroke[]>([])
  const currentStrokeRef = useRef<Stroke | null>(null)

  // Resize canvas to match container
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      canvas.width = rect.width
      canvas.height = rect.height
      redraw()
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke)
    }
    if (currentStrokeRef.current) {
      drawStroke(ctx, currentStrokeRef.current)
    }
  }, [])

  const handlePointerDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true)
    const pos = getPos(e)
    currentStrokeRef.current = {
      points: [pos],
      color: tool === 'eraser' ? '#000000' : color,
      width: tool === 'eraser' ? ERASER_WIDTH : PEN_WIDTH,
      tool,
    }
  }, [getPos, tool, color])

  const handlePointerMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentStrokeRef.current) return
    const pos = getPos(e)
    currentStrokeRef.current.points.push(pos)
    redraw()
  }, [isDrawing, getPos, redraw])

  const handlePointerUp = useCallback(() => {
    if (currentStrokeRef.current && currentStrokeRef.current.points.length > 1) {
      strokesRef.current.push(currentStrokeRef.current)
    }
    currentStrokeRef.current = null
    setIsDrawing(false)
    redraw()
  }, [redraw])

  const undo = useCallback(() => {
    strokesRef.current.pop()
    redraw()
  }, [redraw])

  const clear = useCallback(() => {
    strokesRef.current = []
    currentStrokeRef.current = null
    redraw()
  }, [redraw])

  return (
    <div className={`flex flex-col ${className || ''}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-700 rounded-t-lg">
        <button
          onClick={() => setTool('pen')}
          className={`p-1.5 rounded ${tool === 'pen' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
          title="Pen"
        >
          <Pen className="w-4 h-4" />
        </button>
        <button
          onClick={() => setTool('eraser')}
          className={`p-1.5 rounded ${tool === 'eraser' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
          title="Eraser"
        >
          <Eraser className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* Color palette */}
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => { setColor(c); setTool('pen') }}
            className={`w-5 h-5 rounded-full border-2 transition-transform ${
              color === c && tool === 'pen' ? 'border-white scale-110' : 'border-gray-600'
            }`}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}

        <div className="flex-1" />

        <button onClick={undo} className="p-1.5 rounded text-gray-400 hover:text-white" title="Undo">
          <Undo2 className="w-4 h-4" />
        </button>
        <button onClick={clear} className="p-1.5 rounded text-gray-400 hover:text-red-400" title="Clear">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 bg-gray-950 rounded-b-lg overflow-hidden" style={{ minHeight: 300 }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-crosshair"
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
        />
        {strokesRef.current.length === 0 && !isDrawing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-600 text-sm">Sketch your design here (optional)</p>
          </div>
        )}
      </div>
    </div>
  )
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.points.length < 2) return

  ctx.beginPath()
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (stroke.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
  } else {
    ctx.globalCompositeOperation = 'source-over'
  }

  ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
  }
  ctx.stroke()

  ctx.globalCompositeOperation = 'source-over'
}
