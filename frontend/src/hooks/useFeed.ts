import { useMemo } from 'react'
import type { AgentEvent } from '../api/agents'

// ─── Feed item types ────────────────────────────────────────────────────────

export interface ActivityBlock {
  blockId: string
  streamKey: string
  latest: AgentEvent
  history: AgentEvent[]
}

export type FeedItem =
  | { kind: 'message'; agentId: string; event: AgentEvent; key: string }
  | { kind: 'user'; agentId: string; prompt: string; timestamp: string; key: string; isDispatch?: boolean }
  | { kind: 'activity'; block: ActivityBlock }
  | { kind: 'feedback'; agentId: string; event: AgentEvent; key: string; resolved: boolean; resolvedResponse?: string }

const ACTIVITY_TYPES = new Set(['tool.use', 'file.edit', 'command.output', 'run.node.completed'])

function isActivity(type: string): boolean {
  return ACTIVITY_TYPES.has(type)
}

function mergeDeltaText(previous: string, incoming: string): string {
  if (!incoming) return previous
  if (!previous) return incoming
  if (incoming === previous) return previous
  if (incoming.startsWith(previous)) return incoming
  if (previous.endsWith(incoming)) return previous

  const maxOverlap = Math.min(previous.length, incoming.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.endsWith(incoming.slice(0, size))) {
      return previous + incoming.slice(size)
    }
  }

  return previous + incoming
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UserMessage {
  agentId: string
  prompt: string
  timestamp: string
  isDispatch?: boolean
}

interface UseFeedOptions {
  eventMap: Record<string, AgentEvent[]>
  userMessages: UserMessage[]
  showDeadMessages: boolean
  dismissedAgentIds: Set<string>
  resolvedFeedback: Record<string, string>
  knownAgentIds: Set<string>
}

export function useFeed({
  eventMap,
  userMessages,
  showDeadMessages,
  dismissedAgentIds,
  resolvedFeedback,
  knownAgentIds,
}: UseFeedOptions): FeedItem[] {
  return useMemo((): FeedItem[] => {
    const allRaw: { event: AgentEvent; streamKey: string }[] = []
    for (const [streamKey, evts] of Object.entries(eventMap)) {
      for (const ev of evts) allRaw.push({ event: ev, streamKey })
    }
    for (const msg of userMessages) {
      if (!knownAgentIds.has(msg.agentId)) continue
      allRaw.push({
        streamKey: `agent:${msg.agentId}`,
        event: {
          id: `user-${msg.timestamp}`,
          session_id: '',
          type: 'user.message',
          timestamp: msg.timestamp,
          data: { prompt: msg.prompt, isDispatch: msg.isDispatch },
        },
      })
    }
    allRaw.sort((a, b) => (a.event?.timestamp ?? '').localeCompare(b.event?.timestamp ?? ''))

    // Deduplicate events by ID to prevent double rendering
    const seenIds = new Set<string>()
    const deduped = allRaw.filter(({ event }) => {
      if (seenIds.has(event.id)) return false
      seenIds.add(event.id)
      return true
    })

    const items: FeedItem[] = []
    const textBuffers: Record<
      string,
      {
        idx: number
        partOrder: string[]
        partText: Record<string, string>
      }
    > = {}
    const activityIdx: Record<string, number> = {}

    for (const { event, streamKey } of deduped) {
      const agentId = event.agent_id ?? (streamKey.startsWith('agent:') ? streamKey.slice('agent:'.length) : null)
      if (!showDeadMessages && agentId && dismissedAgentIds.has(agentId)) continue
      if (event.type === 'text.delta') {
        const key = String(event.data.message_id ?? event.data.session_id ?? agentId)
        const partKey = String(event.data.part_id ?? event.id)
        const chunk = String(event.data.delta ?? '')
        if (textBuffers[key] !== undefined) {
          const buffer = textBuffers[key]
          if (!(partKey in buffer.partText)) buffer.partOrder.push(partKey)
          buffer.partText[partKey] = mergeDeltaText(buffer.partText[partKey] ?? '', chunk)
          const accumulated = buffer.partOrder.map((id) => buffer.partText[id] ?? '').join('')
          const item = items[buffer.idx] as Extract<FeedItem, { kind: 'message' }>
          item.event = {
            ...item.event,
            data: { ...item.event.data, accumulated },
          }
        } else {
          textBuffers[key] = {
            idx: items.length,
            partOrder: [partKey],
            partText: { [partKey]: chunk },
          }
          items.push({
            kind: 'message',
            agentId: agentId ?? 'unknown',
            key: event.id,
            event: { ...event, data: { ...event.data, accumulated: chunk } },
          })
          delete activityIdx[streamKey]
        }
      } else if (event.type === 'text.complete') {
        // Do NOT delete the text buffer — if late deltas arrive for the same
        // message_id (e.g., from a message.part.updated after the complete),
        // they should merge into the existing feed item, not create a new one.
      } else if (event.type === 'user.message') {
        items.push({
          kind: 'user',
          agentId: agentId ?? 'unknown',
          key: event.id,
          prompt: String(event.data.prompt ?? ''),
          timestamp: event.timestamp,
          isDispatch: !!event.data.isDispatch,
        })
        delete activityIdx[streamKey]
      } else if (event.type === 'feedback.request') {
        const fbId = String(event.data.feedback_id ?? '')
        items.push({
          kind: 'feedback',
          agentId: agentId ?? 'unknown',
          key: event.id,
          event,
          resolved: fbId in resolvedFeedback,
          resolvedResponse: resolvedFeedback[fbId],
        })
        delete activityIdx[streamKey]
      } else if (event.type === 'feedback.response') {
        // audit-only, skip rendering
      } else if (isActivity(event.type)) {
        const idx = activityIdx[streamKey]
        if (idx !== undefined) {
          const item = items[idx] as Extract<FeedItem, { kind: 'activity' }>
          item.block = {
            ...item.block,
            latest: event,
            history: [...item.block.history, event],
          }
        } else {
          const blockId = `act-${streamKey}-${event.id}`
          activityIdx[streamKey] = items.length
          items.push({
            kind: 'activity',
            block: { blockId, streamKey, latest: event, history: [event] },
          })
        }
      }
    }

    return items
  }, [eventMap, userMessages, showDeadMessages, dismissedAgentIds, resolvedFeedback, knownAgentIds])
}
