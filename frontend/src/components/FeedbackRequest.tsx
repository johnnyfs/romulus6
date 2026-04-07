import { useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import type { AgentEvent } from '../api/agents'

interface FeedbackRequestProps {
  event: AgentEvent
  agentLabel: string
  resolved: boolean
  resolvedResponse?: string
  disabled: boolean
  onRespond: (feedbackId: string, feedbackType: string, response: string) => void
}

export default function FeedbackRequest({
  event,
  agentLabel,
  resolved,
  resolvedResponse,
  disabled,
  onRespond,
}: FeedbackRequestProps) {
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)

  const feedbackId = String(event.data.feedback_id ?? '')
  const feedbackType = String(event.data.feedback_type ?? 'approve')
  const title = String(event.data.title ?? 'Agent needs input')
  const description = String(event.data.description ?? '')
  const context = (event.data.context ?? {}) as Record<string, unknown>

  const isDisabled = resolved || disabled || sending

  function handleRespond(response: string) {
    if (isDisabled) return
    setSending(true)
    onRespond(feedbackId, feedbackType, response)
  }

  return (
    <div style={fbStyles.card}>
      <div style={fbStyles.header}>
        <span style={fbStyles.agentLabel}>{agentLabel}</span>
        <span style={fbStyles.badge}>
          {feedbackType === 'approve' ? 'approval needed' : feedbackType === 'select' ? 'choice needed' : 'input needed'}
        </span>
      </div>
      <div style={fbStyles.title}>{title}</div>
      {description && <div style={fbStyles.description}>{description}</div>}

      {feedbackType === 'approve' && (
        <ApproveControls
          context={context}
          resolved={resolved}
          resolvedResponse={resolvedResponse}
          disabled={isDisabled}
          onRespond={handleRespond}
        />
      )}

      {feedbackType === 'select' && (
        <SelectControls
          context={context}
          resolved={resolved}
          resolvedResponse={resolvedResponse}
          disabled={isDisabled}
          onRespond={handleRespond}
        />
      )}

      {feedbackType === 'input' && (
        <InputControls
          context={context}
          resolved={resolved}
          resolvedResponse={resolvedResponse}
          disabled={isDisabled}
          inputValue={inputValue}
          onInputChange={setInputValue}
          onRespond={handleRespond}
        />
      )}
    </div>
  )
}

// ─── Approve variant ─────────────────────────────────────────────────────────

function ApproveControls({
  context,
  resolved,
  resolvedResponse,
  disabled,
  onRespond,
}: {
  context: Record<string, unknown>
  resolved: boolean
  resolvedResponse?: string
  disabled: boolean
  onRespond: (response: string) => void
}) {
  const diff = context.diff ? String(context.diff) : null
  const command = context.command ? String(context.command) : null
  const path = context.path ? String(context.path) : null

  return (
    <>
      {path && <div style={fbStyles.contextLine}>File: <code>{path}</code></div>}
      {command && (
        <pre style={fbStyles.codeBlock}>$ {command}</pre>
      )}
      {diff && (
        <pre style={fbStyles.codeBlock}>{diff}</pre>
      )}
      {resolved ? (
        <div style={{
          ...fbStyles.resolvedLabel,
          color: resolvedResponse === 'approved' ? 'var(--accent)' : 'var(--danger)',
        }}>
          {resolvedResponse === 'approved' ? 'Approved' : 'Rejected'}
        </div>
      ) : (
        <div style={fbStyles.buttonRow}>
          <button
            style={{ ...fbStyles.btn, ...fbStyles.approveBtn }}
            disabled={disabled}
            onClick={() => onRespond('approved')}
          >
            Approve
          </button>
          <button
            style={{ ...fbStyles.btn, ...fbStyles.rejectBtn }}
            disabled={disabled}
            onClick={() => onRespond('rejected')}
          >
            Reject
          </button>
        </div>
      )}
    </>
  )
}

// ─── Select variant ──────────────────────────────────────────────────────────

function SelectControls({
  context,
  resolved,
  resolvedResponse,
  disabled,
  onRespond,
}: {
  context: Record<string, unknown>
  resolved: boolean
  resolvedResponse?: string
  disabled: boolean
  onRespond: (response: string) => void
}) {
  const options = Array.isArray(context.options)
    ? (context.options as string[]).map(String)
    : []

  return (
    <div style={fbStyles.optionList}>
      {options.map((opt) => {
        const isSelected = resolved && resolvedResponse === opt
        return (
          <button
            key={opt}
            style={{
              ...fbStyles.btn,
              ...fbStyles.optionBtn,
              ...(isSelected ? fbStyles.optionSelected : {}),
              ...(resolved && !isSelected ? { opacity: 0.4 } : {}),
            }}
            disabled={disabled}
            onClick={() => onRespond(opt)}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

// ─── Input variant ───────────────────────────────────────────────────────────

function InputControls({
  context,
  resolved,
  resolvedResponse,
  disabled,
  inputValue,
  onInputChange,
  onRespond,
}: {
  context: Record<string, unknown>
  resolved: boolean
  resolvedResponse?: string
  disabled: boolean
  inputValue: string
  onInputChange: (v: string) => void
  onRespond: (response: string) => void
}) {
  const fbRef = useAutoResize(inputValue, 90)
  const question = context.question ? String(context.question) : null

  return (
    <>
      {question && <div style={fbStyles.question}>{question}</div>}
      {resolved ? (
        <div style={fbStyles.resolvedLabel}>{resolvedResponse}</div>
      ) : (
        <div style={fbStyles.inputRow}>
          <textarea
            ref={fbRef}
            rows={1}
            style={fbStyles.textInput}
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="Type your response..."
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && inputValue.trim()) {
                e.preventDefault()
                onRespond(inputValue.trim())
              }
            }}
          />
          <button
            style={{ ...fbStyles.btn, ...fbStyles.submitBtn }}
            disabled={disabled || !inputValue.trim()}
            onClick={() => onRespond(inputValue.trim())}
          >
            Submit
          </button>
        </div>
      )}
    </>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const fbStyles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid var(--border)',
    borderLeft: '3px solid #e0a855',
    borderRadius: '6px',
    padding: '12px 16px',
    background: 'var(--surface)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  agentLabel: {
    color: 'var(--accent)',
    fontSize: '12px',
    fontWeight: 600,
  },
  badge: {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#e0a855',
    background: 'rgba(224, 168, 85, 0.12)',
    padding: '2px 6px',
    borderRadius: '3px',
  },
  title: {
    color: 'var(--text)',
    fontSize: '14px',
    fontWeight: 500,
  },
  description: {
    color: 'var(--text-dim)',
    fontSize: '13px',
  },
  contextLine: {
    color: 'var(--text-dim)',
    fontSize: '12px',
  },
  codeBlock: {
    margin: 0,
    padding: '8px 10px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-dim)',
    fontFamily: "'Menlo', 'Consolas', monospace",
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  buttonRow: {
    display: 'flex',
    gap: '8px',
    marginTop: '4px',
  },
  btn: {
    padding: '6px 14px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    fontFamily: 'inherit',
  },
  approveBtn: {
    background: 'var(--accent)',
    color: '#fff',
  },
  rejectBtn: {
    background: 'var(--danger)',
    color: '#fff',
  },
  optionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '4px',
  },
  optionBtn: {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    textAlign: 'left',
    padding: '8px 12px',
  },
  optionSelected: {
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    marginTop: '4px',
  },
  textInput: {
    flex: 1,
    padding: '7px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text)',
    outline: 'none',
    fontSize: '13px',
    fontFamily: 'inherit',
    resize: 'none' as const,
    lineHeight: '1.4',
  },
  submitBtn: {
    background: 'var(--accent)',
    color: '#fff',
  },
  question: {
    color: 'var(--text)',
    fontSize: '13px',
    fontStyle: 'italic',
  },
  resolvedLabel: {
    color: 'var(--text-dim)',
    fontSize: '13px',
    fontStyle: 'italic',
    marginTop: '4px',
  },
}
