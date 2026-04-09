import { useCallback, useEffect, useRef, useState } from 'react'

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

interface UseEventStreamOptions {
  /** Start the stream. When false, the stream is disconnected. */
  enabled: boolean
  /** Recreate the stream when this value changes. */
  resetKey?: unknown
  /** Called when an error occurs (for surfacing to UI). */
  onError?: (error: Error) => void
}

/**
 * Manages an SSE stream connection with auto-reconnect and exponential backoff.
 *
 * `connect` is called to initiate the stream. It should return a promise that
 * resolves when the stream closes normally or rejects on error.
 * The signal passed to `connect` is aborted on cleanup or reconnect.
 */
export function useEventStream(
  connect: (signal: AbortSignal) => Promise<void>,
  { enabled, resetKey, onError }: UseEventStreamOptions,
): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const connectRef = useRef(connect)
  const onErrorRef = useRef(onError)

  // Keep refs current without triggering re-renders of the effect
  const syncRefs = useCallback(() => {
    connectRef.current = connect
    onErrorRef.current = onError
  }, [connect, onError])

  useEffect(() => {
    syncRefs()
  }, [syncRefs])

  useEffect(() => {
    if (!enabled) return

    let aborted = false
    const ctrl = new AbortController()

    async function run() {
      let backoff = 1000
      const MAX_BACKOFF = 30000
      setStatus('connecting')

      while (!aborted) {
        try {
          await connectRef.current(ctrl.signal)
          // Stream ended normally (server closed connection). Reconnect.
          if (aborted) break
          setStatus('reconnecting')
        } catch (err) {
          if (aborted || ctrl.signal.aborted) break
          const error = err instanceof Error ? err : new Error(String(err))
          console.error('Event stream error:', error)
          onErrorRef.current?.(error)
          setStatus('error')
        }

        if (aborted) break

        // Wait with exponential backoff before reconnecting
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoff)
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })

        if (aborted) break
        setStatus('reconnecting')
        backoff = Math.min(backoff * 2, MAX_BACKOFF)
      }
    }

    run().catch(() => {
      // run() handles its own errors; this catch is a safety net
    })

    return () => {
      aborted = true
      ctrl.abort()
      setStatus('idle')
    }
  }, [enabled, resetKey])

  return status
}
