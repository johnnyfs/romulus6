import { useEffect, useRef } from 'react'

export function useAutoResize(value: string, maxHeight: number, minHeight?: number) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const desired = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${Math.max(desired, minHeight ?? 0)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, maxHeight, minHeight])

  return ref
}
