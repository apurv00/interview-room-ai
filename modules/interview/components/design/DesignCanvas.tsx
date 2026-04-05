'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Send, Undo2, Trash2, Link2, MousePointer } from 'lucide-react'
import ComponentPalette, { PALETTE_ITEMS } from './ComponentPalette'
import type { DesignComponent, DesignConnection, DesignComponentType, DesignSubmission } from '@shared/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1
function genId() { return `node-${nextId++}` }
function connId() { return `conn-${nextId++}` }

const NODE_W = 120
const NODE_H = 52
const GRID_SIZE = 40
const CANVAS_PADDING = 80 // extra space beyond outermost node

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

function getNodeCenter(node: DesignComponent) {
  return { x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface DesignCanvasProps {
  onSubmit: (data: DesignSubmission) => void
  questionIndex: number
  disabled?: boolean
}

type CanvasMode = 'select' | 'connect'

export default function DesignCanvas({ onSubmit, questionIndex, disabled = false }: DesignCanvasProps) {
  const [components, setComponents] = useState<DesignComponent[]>([])
  const [connections, setConnections] = useState<DesignConnection[]>([])
  const [mode, setMode] = useState<CanvasMode>('select')
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<Array<{ components: DesignComponent[]; connections: DesignConnection[] }>>([])

  // ── Compute canvas inner size from node bounding box ──
  const canvasInnerSize = useMemo(() => {
    if (components.length === 0) return { width: '100%', height: '100%' }
    let maxX = 0
    let maxY = 0
    for (const c of components) {
      maxX = Math.max(maxX, c.x + NODE_W)
      maxY = Math.max(maxY, c.y + NODE_H)
    }
    const container = canvasRef.current
    const minW = container?.clientWidth ?? 800
    const minH = container?.clientHeight ?? 500
    return {
      width: Math.max(minW, maxX + CANVAS_PADDING),
      height: Math.max(minH, maxY + CANVAS_PADDING),
    }
  }, [components])

  // ── Save history for undo ──
  const saveHistory = useCallback(() => {
    historyRef.current.push({
      components: components.map((c) => ({ ...c })),
      connections: connections.map((c) => ({ ...c })),
    })
    if (historyRef.current.length > 50) historyRef.current.shift()
  }, [components, connections])

  // ── Add component from palette ──
  const handleAddComponent = useCallback((type: DesignComponentType) => {
    if (disabled) return
    saveHistory()
    const canvas = canvasRef.current
    const scrollLeft = canvas?.scrollLeft ?? 0
    const scrollTop = canvas?.scrollTop ?? 0
    const cw = canvas?.clientWidth ?? 600
    const ch = canvas?.clientHeight ?? 400
    // Place near center of visible area, staggered by count
    const count = components.length
    const col = count % 4
    const row = Math.floor(count / 4)
    const centerX = scrollLeft + cw / 2 - NODE_W / 2
    const centerY = scrollTop + ch / 2 - NODE_H / 2
    const x = snapToGrid(centerX + (col - 1.5) * (NODE_W + 20))
    const y = snapToGrid(centerY + (row - 1) * (NODE_H + 30))
    const label = PALETTE_ITEMS.find((p) => p.type === type)?.label ?? type
    setComponents((prev) => [...prev, {
      id: genId(),
      type,
      label,
      x: Math.max(0, x),
      y: Math.max(0, y),
    }])
  }, [disabled, saveHistory, components.length])

  // ── Start drag ──
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (disabled) return
    if (mode === 'connect') {
      if (!connectFrom) {
        setConnectFrom(nodeId)
      } else if (connectFrom !== nodeId) {
        saveHistory()
        const exists = connections.some(
          (c) => (c.from === connectFrom && c.to === nodeId) || (c.from === nodeId && c.to === connectFrom)
        )
        if (!exists) {
          setConnections((prev) => [...prev, { id: connId(), from: connectFrom, to: nodeId }])
        }
        setConnectFrom(null)
      }
      return
    }
    // Select mode: start dragging
    e.preventDefault()
    e.stopPropagation()
    const node = components.find((c) => c.id === nodeId)
    if (!node) return
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    if (!canvasRect) return
    const scrollLeft = canvasRef.current?.scrollLeft ?? 0
    const scrollTop = canvasRef.current?.scrollTop ?? 0
    // Store offset: mouse position relative to canvas (including scroll) minus node position
    setDragging(nodeId)
    setDragOffset({
      x: e.clientX - canvasRect.left + scrollLeft - node.x,
      y: e.clientY - canvasRect.top + scrollTop - node.y,
    })
    saveHistory()
  }, [disabled, mode, connectFrom, saveHistory, connections, components])

  // ── Drag move ──
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || disabled) return
    const canvas = canvasRef.current
    if (!canvas) return
    const canvasRect = canvas.getBoundingClientRect()
    const scrollLeft = canvas.scrollLeft
    const scrollTop = canvas.scrollTop
    // Calculate position relative to canvas content (including scroll)
    const rawX = e.clientX - canvasRect.left + scrollLeft - dragOffset.x
    const rawY = e.clientY - canvasRect.top + scrollTop - dragOffset.y
    const x = snapToGrid(Math.max(0, rawX))
    const y = snapToGrid(Math.max(0, rawY))
    setComponents((prev) => prev.map((c) => c.id === dragging ? { ...c, x, y } : c))
  }, [dragging, disabled, dragOffset])

  // ── Drag end ──
  const handleMouseUp = useCallback(() => {
    setDragging(null)
  }, [])

  // ── Undo ──
  const handleUndo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (prev) {
      setComponents(prev.components)
      setConnections(prev.connections)
    }
  }, [])

  // ── Clear ──
  const handleClear = useCallback(() => {
    saveHistory()
    setComponents([])
    setConnections([])
    setConnectFrom(null)
  }, [saveHistory])

  // ── Delete node ──
  const handleDeleteNode = useCallback((nodeId: string) => {
    saveHistory()
    setComponents((prev) => prev.filter((c) => c.id !== nodeId))
    setConnections((prev) => prev.filter((c) => c.from !== nodeId && c.to !== nodeId))
    if (connectFrom === nodeId) setConnectFrom(null)
  }, [saveHistory, connectFrom])

  // ── Submit ──
  const handleSubmit = useCallback(() => {
    if (disabled) return
    onSubmit({
      components,
      connections,
      questionIndex,
      submittedAt: Date.now(),
    })
  }, [disabled, onSubmit, components, connections, questionIndex])

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-gray-700/50 shadow-lg">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#1e1f2e] border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          {/* Mode toggles */}
          <button
            onClick={() => { setMode('select'); setConnectFrom(null) }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors ${
              mode === 'select' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
            title="Select & Move"
          >
            <MousePointer className="w-3.5 h-3.5" />
            Move
          </button>
          <button
            onClick={() => { setMode('connect'); setDragging(null) }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors ${
              mode === 'connect' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
            }`}
            title="Connect components"
          >
            <Link2 className="w-3.5 h-3.5" />
            Connect
          </button>

          <div className="w-px h-5 bg-gray-700/50 mx-1" />

          {/* Undo / Clear */}
          <button
            onClick={handleUndo}
            className="p-1.5 rounded text-gray-400 hover:text-white transition-colors"
            title="Undo"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleClear}
            className="p-1.5 rounded text-gray-400 hover:text-red-400 transition-colors"
            title="Clear all"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-5 bg-gray-700/50 mx-1" />

          {/* Component count */}
          <span className="text-xs text-gray-500">
            {components.length} components · {connections.length} connections
          </span>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={disabled || components.length === 0}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-md transition-all shadow-sm hover:shadow-emerald-500/20"
          title="Submit design"
        >
          <Send className="w-3.5 h-3.5" />
          Submit
        </button>
      </div>

      {/* Main area: palette + canvas */}
      <div className="flex flex-1 min-h-0">
        {/* Palette sidebar */}
        <div className="w-[160px] shrink-0 bg-gray-900/60 border-r border-gray-700/50 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold px-2 pt-2 pb-1">Components</p>
          <ComponentPalette disabled={disabled} onAddComponent={handleAddComponent} />
        </div>

        {/* Canvas area — scrollable */}
        <div
          ref={canvasRef}
          className={`relative flex-1 bg-gray-950 overflow-auto ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'}`}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ minHeight: 300 }}
        >
          {/* Inner container that expands with content */}
          <div
            className="relative"
            style={{
              width: typeof canvasInnerSize.width === 'number' ? canvasInnerSize.width : undefined,
              height: typeof canvasInnerSize.height === 'number' ? canvasInnerSize.height : undefined,
              minWidth: '100%',
              minHeight: '100%',
            }}
          >
            {/* Grid pattern background */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              <defs>
                <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="0.5" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#grid)" />
            </svg>

            {/* SVG connection lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 1 }}>
              <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="#60a5fa" />
                </marker>
              </defs>
              {connections.map((conn) => {
                const fromNode = components.find((c) => c.id === conn.from)
                const toNode = components.find((c) => c.id === conn.to)
                if (!fromNode || !toNode) return null
                const from = getNodeCenter(fromNode)
                const to = getNodeCenter(toNode)
                return (
                  <line
                    key={conn.id}
                    x1={from.x} y1={from.y}
                    x2={to.x} y2={to.y}
                    stroke="#60a5fa"
                    strokeWidth={2}
                    markerEnd="url(#arrowhead)"
                    opacity={0.7}
                  />
                )
              })}
            </svg>

            {/* Component nodes */}
            {components.map((node) => {
              const item = PALETTE_ITEMS.find((p) => p.type === node.type)
              const isConnectSource = connectFrom === node.id
              const isDragging = dragging === node.id
              return (
                <div
                  key={node.id}
                  className={`absolute flex items-center gap-2 px-3 py-2 rounded-lg border select-none transition-shadow ${
                    isDragging
                      ? 'cursor-grabbing shadow-lg shadow-black/40 scale-105'
                      : mode === 'connect'
                        ? 'cursor-pointer'
                        : 'cursor-grab'
                  } ${
                    isConnectSource
                      ? 'border-blue-400 bg-blue-900/40 text-blue-200 ring-2 ring-blue-500/50'
                      : 'border-gray-600 bg-gray-800/90 text-gray-200 hover:border-gray-400'
                  }`}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: NODE_W,
                    height: NODE_H,
                    zIndex: isDragging ? 10 : 2,
                  }}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  onDoubleClick={() => !disabled && handleDeleteNode(node.id)}
                  title={`${node.label}\nDouble-click to delete`}
                >
                  <span className="shrink-0 text-gray-400">{item?.icon}</span>
                  <span className="text-xs font-medium truncate">{node.label}</span>
                </div>
              )
            })}

            {/* Empty state */}
            {components.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 0 }}>
                <div className="text-center">
                  <p className="text-gray-600 text-sm">Click components from the palette to add them</p>
                  <p className="text-gray-700 text-xs mt-1">Then use Connect mode to draw arrows between them</p>
                </div>
              </div>
            )}

            {/* Connect mode indicator */}
            {mode === 'connect' && connectFrom && (
              <div className="fixed bottom-16 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-xs px-3 py-1.5 rounded-full" style={{ zIndex: 20 }}>
                Click a target node to complete the connection
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#1e1f2e] border-t border-gray-700/50 text-[11px] text-gray-500">
        <div className="flex items-center gap-3">
          <span>Mode: {mode === 'select' ? 'Move' : 'Connect'}</span>
          <span>Double-click node to delete</span>
        </div>
        <div className="flex items-center gap-3">
          {disabled && <span className="text-amber-500">Read Only</span>}
          <span>{components.length} nodes</span>
        </div>
      </div>
    </div>
  )
}
