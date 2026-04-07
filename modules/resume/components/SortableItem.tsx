'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { GripVertical } from 'lucide-react'

/* eslint-disable @typescript-eslint/no-explicit-any */
type DragRenderFn = (props: { listeners: any; attributes: any }) => ReactNode

interface Props {
  id: string
  children: DragRenderFn
}

export function DragHandle({ listeners, attributes }: { listeners?: any; attributes?: any }) {
  return (
    <button
      type="button"
      className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-500 transition-colors touch-none"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="w-4 h-4" />
    </button>
  )
}

export default function SortableItem({ id, children }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style}>
      {children({ listeners, attributes })}
    </div>
  )
}
