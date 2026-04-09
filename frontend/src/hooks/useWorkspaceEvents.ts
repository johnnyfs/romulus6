import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '../api/agents'
import { listWorkspaceEvents, streamWorkspaceEvents } from '../api/workspaceEvents'
import { useEventStream, type ConnectionStatus } from './useEventStream'

export interface WorkspaceEventsResult {
  eventMap: Record<string, AgentEvent[]>
  agentBusy: Record<string, boolean>
  agentTerminal: Record<string, boolean>
  agentWaiting: Record<string, boolean>
  resolvedFeedback: Record<string, string>
  streamStatus: ConnectionStatus
  setResolvedFeedback: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setAgentTerminal: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setAgentWaiting: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setEventMap: React.Dispatch<React.SetStateAction<Record<string, AgentEvent[]>>>
}

export function useWorkspaceEvents(
  workspaceId: string | undefined,
  enabled: boolean,
  onError: (message: string) => void,
): WorkspaceEventsResult {
  const [eventMap, setEventMap] = useState<Record<string, AgentEvent[]>>({})
  const [agentBusy, setAgentBusy] = useState<Record<string, boolean>>({})
  const [agentTerminal, setAgentTerminal] = useState<Record<string, boolean>>({})
  const [agentWaiting, setAgentWaiting] = useState<Record<string, boolean>>({})
  const [resolvedFeedback, setResolvedFeedback] = useState<Record<string, string>>({})

  const seenEventIds = useRef<Set<string>>(new Set())
  const eventCursor = useRef(0)
  const pendingEvents = useRef<AgentEvent[]>([])
  const flushRafId = useRef(0)

  const flushEvents = useCallback(() => {
    flushRafId.current = 0
    const batch = pendingEvents.current
    if (batch.length === 0) return
    pendingEvents.current = []

    const mapUpdates: Record<string, AgentEvent[]> = {}
    const busyUpdates: Record<string, boolean> = {}
    const waitingUpdates: Record<string, boolean> = {}
    const terminalUpdates: Record<string, boolean> = {}
    const resolvedUpdates: Record<string, string> = {}

    for (const event of batch) {
      const streamKey = event.stream_key ?? event.agent_id ?? event.node_id ?? event.run_id ?? event.source_id ?? 'unknown'
      const agentId = event.agent_id ?? null
      eventCursor.current += 1
      if (!event.type.startsWith('session.')) {
        if (!seenEventIds.current.has(event.id)) {
          seenEventIds.current.add(event.id)
          if (!mapUpdates[streamKey]) mapUpdates[streamKey] = []
          mapUpdates[streamKey].push(event)
        }
      }
      if (agentId && event.type === 'session.busy') {
        busyUpdates[agentId] = true
        waitingUpdates[agentId] = false
      } else if (agentId && event.type === 'session.idle') {
        busyUpdates[agentId] = false
      } else if (
        agentId &&
        (
          event.type === 'session.completed' ||
          event.type === 'session.error' ||
          event.type === 'session.interrupted'
        )
      ) {
        busyUpdates[agentId] = false
        waitingUpdates[agentId] = false
        terminalUpdates[agentId] = true
      }
      if (agentId && event.type === 'feedback.request') {
        busyUpdates[agentId] = false
        waitingUpdates[agentId] = true
      } else if (agentId && event.type === 'feedback.response') {
        const fbId = String(event.data?.feedback_id ?? '')
        const fbResp = String(event.data?.response ?? '')
        if (fbId) resolvedUpdates[fbId] = fbResp
        waitingUpdates[agentId] = false
      }
    }

    if (Object.keys(mapUpdates).length > 0) {
      setEventMap((prev) => {
        const next = { ...prev }
        for (const [key, events] of Object.entries(mapUpdates)) {
          next[key] = [...(prev[key] ?? []), ...events]
        }
        return next
      })
    }
    if (Object.keys(busyUpdates).length > 0) setAgentBusy((prev) => ({ ...prev, ...busyUpdates }))
    if (Object.keys(waitingUpdates).length > 0) setAgentWaiting((prev) => ({ ...prev, ...waitingUpdates }))
    if (Object.keys(terminalUpdates).length > 0) setAgentTerminal((prev) => ({ ...prev, ...terminalUpdates }))
    if (Object.keys(resolvedUpdates).length > 0) setResolvedFeedback((prev) => ({ ...prev, ...resolvedUpdates }))
  }, [])

  const applyEvent = useCallback((event: AgentEvent) => {
    pendingEvents.current.push(event)
    if (!flushRafId.current) {
      flushRafId.current = requestAnimationFrame(flushEvents)
    }
  }, [flushEvents])

  // Clean up pending RAF on unmount
  useEffect(() => {
    return () => {
      if (flushRafId.current) cancelAnimationFrame(flushRafId.current)
    }
  }, [])

  const connectStream = useCallback(async (signal: AbortSignal) => {
    if (!workspaceId) return
    // Discard any buffered events from the previous stream to avoid duplicates
    pendingEvents.current = []
    if (flushRafId.current) {
      cancelAnimationFrame(flushRafId.current)
      flushRafId.current = 0
    }
    const events = await listWorkspaceEvents(workspaceId, 0, 1000)
    if (signal.aborted) return
    const nextMap: Record<string, AgentEvent[]> = {}
    const nextTerminal: Record<string, boolean> = {}
    const nextBusy: Record<string, boolean> = {}
    const nextWaiting: Record<string, boolean> = {}
    const nextResolved: Record<string, string> = {}
    let lastEventId = 0
    seenEventIds.current.clear()
    eventCursor.current = 0
    for (const event of events) {
      eventCursor.current += 1
      lastEventId = eventCursor.current
      const streamKey = event.stream_key ?? event.agent_id ?? event.node_id ?? event.run_id ?? event.source_id ?? 'unknown'
      const agentId = event.agent_id ?? null
      if (!event.type.startsWith('session.')) {
        seenEventIds.current.add(event.id)
        nextMap[streamKey] = [...(nextMap[streamKey] ?? []), event]
      }
      if (agentId && event.type === 'session.busy') {
        nextBusy[agentId] = true
        nextWaiting[agentId] = false
      }
      if (agentId && event.type === 'session.idle') nextBusy[agentId] = false
      if (
        agentId &&
        (
          event.type === 'session.completed' ||
          event.type === 'session.error' ||
          event.type === 'session.interrupted'
        )
      ) {
        nextBusy[agentId] = false
        nextTerminal[agentId] = true
        nextWaiting[agentId] = false
      }
      if (agentId && event.type === 'feedback.request') {
        nextBusy[agentId] = false
        nextWaiting[agentId] = true
      } else if (agentId && event.type === 'feedback.response') {
        const fbId = String(event.data?.feedback_id ?? '')
        const fbResp = String(event.data?.response ?? '')
        if (fbId) nextResolved[fbId] = fbResp
        nextWaiting[agentId] = false
      }
    }
    setEventMap(nextMap)
    setAgentBusy(nextBusy)
    setAgentTerminal(nextTerminal)
    setAgentWaiting(nextWaiting)
    setResolvedFeedback(nextResolved)
    await streamWorkspaceEvents(workspaceId, lastEventId, applyEvent, signal)
  }, [workspaceId, applyEvent])

  const streamStatus = useEventStream(connectStream, {
    enabled,
    onError: (err) => onError(err.message),
  })

  return {
    eventMap,
    agentBusy,
    agentTerminal,
    agentWaiting,
    resolvedFeedback,
    streamStatus,
    setResolvedFeedback,
    setAgentTerminal,
    setAgentWaiting,
    setEventMap,
  }
}
