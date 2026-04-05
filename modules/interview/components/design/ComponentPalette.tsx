'use client'

import {
  Monitor, Globe, GitBranch, Shield,
  Server, Cpu, Box, Database,
  Zap, ArrowRightLeft, HardDrive, Search,
  Bell, Activity, Plus,
} from 'lucide-react'
import type { DesignComponentType } from '@shared/types'

export interface PaletteItem {
  type: DesignComponentType
  label: string
  icon: React.ReactNode
}

export const PALETTE_ITEMS: PaletteItem[] = [
  { type: 'client', label: 'Client', icon: <Monitor className="w-4 h-4" /> },
  { type: 'cdn', label: 'CDN', icon: <Globe className="w-4 h-4" /> },
  { type: 'load_balancer', label: 'Load Balancer', icon: <GitBranch className="w-4 h-4" /> },
  { type: 'api_gateway', label: 'API Gateway', icon: <Shield className="w-4 h-4" /> },
  { type: 'web_server', label: 'Web Server', icon: <Server className="w-4 h-4" /> },
  { type: 'app_server', label: 'App Server', icon: <Cpu className="w-4 h-4" /> },
  { type: 'microservice', label: 'Service', icon: <Box className="w-4 h-4" /> },
  { type: 'database', label: 'Database', icon: <Database className="w-4 h-4" /> },
  { type: 'cache', label: 'Cache', icon: <Zap className="w-4 h-4" /> },
  { type: 'message_queue', label: 'Queue', icon: <ArrowRightLeft className="w-4 h-4" /> },
  { type: 'storage', label: 'Storage', icon: <HardDrive className="w-4 h-4" /> },
  { type: 'search', label: 'Search', icon: <Search className="w-4 h-4" /> },
  { type: 'notification', label: 'Notifier', icon: <Bell className="w-4 h-4" /> },
  { type: 'monitoring', label: 'Monitor', icon: <Activity className="w-4 h-4" /> },
  { type: 'custom', label: 'Custom', icon: <Plus className="w-4 h-4" /> },
]

interface ComponentPaletteProps {
  disabled?: boolean
  onAddComponent: (type: DesignComponentType) => void
}

export default function ComponentPalette({ disabled, onAddComponent }: ComponentPaletteProps) {
  return (
    <div className="grid grid-cols-3 gap-1.5 p-2">
      {PALETTE_ITEMS.map((item) => (
        <button
          key={item.type}
          disabled={disabled}
          onClick={() => onAddComponent(item.type)}
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-md text-gray-400 hover:text-white hover:bg-gray-700/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-[10px]"
          title={`Add ${item.label}`}
        >
          {item.icon}
          <span className="truncate w-full text-center">{item.label}</span>
        </button>
      ))}
    </div>
  )
}
