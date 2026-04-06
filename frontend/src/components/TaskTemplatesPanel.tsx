import { useCallback, useEffect, useState } from 'react'
import type { NodeType } from '../api/graphs'
import {
  type TaskTemplate,
  type TaskTemplateArgType,
  createTaskTemplate,
  deleteTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  updateTaskTemplate,
} from '../api/templates'

const MODEL_OPTIONS = [
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'openai/o3-mini', label: 'o3 Mini' },
]

export default function TaskTemplatesPanel({ workspaceId }: { workspaceId: string }) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskTemplate | null>(null)
  const [mutating, setMutating] = useState(false)

  // Edit state
  const [editName, setEditName] = useState('')
  const [editTaskType, setEditTaskType] = useState<NodeType>('agent')
  const [editAgentType, setEditAgentType] = useState('opencode')
  const [editModel, setEditModel] = useState(MODEL_OPTIONS[0].value)
  const [editPrompt, setEditPrompt] = useState('')
  const [editCommand, setEditCommand] = useState('')
  const [editGraphTools, setEditGraphTools] = useState(false)
  const [editArgs, setEditArgs] = useState<{ name: string; arg_type: TaskTemplateArgType; default_value: string; model_constraint: string[] }[]>([])

  const loadList = useCallback(async () => {
    const ts = await listTaskTemplates(workspaceId)
    setTemplates(ts)
    return ts
  }, [workspaceId])

  const loadDetail = useCallback(async (id: string) => {
    const t = await getTaskTemplate(workspaceId, id)
    setDetail(t)
    return t
  }, [workspaceId])

  useEffect(() => {
    loadList().then((ts) => {
      if (ts.length > 0) setActiveId(ts[0].id)
    })
  }, [loadList])

  useEffect(() => {
    if (activeId) {
      loadDetail(activeId).then((t) => {
        setEditName(t.name)
        setEditTaskType(t.task_type)
        setEditAgentType(t.agent_type ?? 'opencode')
        setEditModel(t.model ?? MODEL_OPTIONS[0].value)
        setEditPrompt(t.prompt ?? '')
        setEditCommand(t.command ?? '')
        setEditGraphTools(t.graph_tools)
        setEditArgs(
          t.arguments.map((a) => ({
            name: a.name,
            arg_type: a.arg_type,
            default_value: a.default_value ?? '',
            model_constraint: a.model_constraint ?? [],
          })),
        )
      })
    } else {
      setDetail(null)
    }
  }, [activeId, loadDetail])

  async function handleCreate() {
    const name = window.prompt('Template name:')
    if (!name?.trim()) return
    setMutating(true)
    try {
      const t = await createTaskTemplate(workspaceId, { name: name.trim(), task_type: 'agent' })
      await loadList()
      setActiveId(t.id)
    } finally {
      setMutating(false)
    }
  }

  async function handleDelete() {
    if (!activeId) return
    if (!window.confirm('Delete this template?')) return
    setMutating(true)
    try {
      await deleteTaskTemplate(workspaceId, activeId)
      const ts = await loadList()
      setActiveId(ts.length > 0 ? ts[0].id : null)
    } finally {
      setMutating(false)
    }
  }

  async function handleSave() {
    if (!activeId || !detail) return
    setMutating(true)
    try {
      await updateTaskTemplate(workspaceId, activeId, {
        name: editName,
        task_type: editTaskType,
        agent_type: editTaskType === 'agent' ? editAgentType : undefined,
        model: editTaskType === 'agent' ? editModel : undefined,
        prompt: editTaskType === 'agent' ? editPrompt : undefined,
        command: editTaskType === 'command' ? editCommand : undefined,
        graph_tools: editTaskType === 'agent' ? editGraphTools : false,
        arguments: editArgs.map((a) => ({
          name: a.name,
          arg_type: a.arg_type,
          default_value: a.default_value || undefined,
          model_constraint: a.model_constraint.length > 0 ? a.model_constraint : undefined,
        })),
      })
      await loadList()
      await loadDetail(activeId)
    } finally {
      setMutating(false)
    }
  }

  function addArg() {
    setEditArgs([...editArgs, { name: '', arg_type: 'string', default_value: '', model_constraint: [] }])
  }

  function removeArg(idx: number) {
    setEditArgs(editArgs.filter((_, i) => i !== idx))
  }

  function updateArg(idx: number, field: string, value: any) {
    setEditArgs(editArgs.map((a, i) => (i === idx ? { ...a, [field]: value } : a)))
  }

  return (
    <div style={s.wrap}>
      {/* Header */}
      <div style={s.headerBar}>
        <select
          style={s.select}
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value || null)}
          disabled={mutating}
        >
          {templates.length === 0 && <option value="">-- no templates --</option>}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <button style={s.iconBtn} onClick={handleCreate} disabled={mutating} title="New">+</button>
        <button
          style={{ ...s.iconBtn, opacity: activeId ? 1 : 0.4 }}
          onClick={handleDelete}
          disabled={!activeId || mutating}
          title="Delete"
        >x</button>
      </div>

      {/* Editor */}
      {detail && (
        <div style={s.editor}>
          <div style={s.hint}>Use {'{{ arg_name }}'} in fields for substitution</div>

          <div style={s.row}>
            <span style={s.label}>Name</span>
            <input style={s.input} value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>

          <div style={s.row}>
            <span style={s.label}>Type</span>
            <select style={s.sel} value={editTaskType} onChange={(e) => setEditTaskType(e.target.value as NodeType)}>
              <option value="agent">agent</option>
              <option value="command">command</option>
            </select>
          </div>

          {editTaskType === 'agent' && (
            <>
              <div style={s.row}>
                <span style={s.label}>Model</span>
                <input style={s.input} value={editModel} onChange={(e) => setEditModel(e.target.value)} list="model-opts" />
                <datalist id="model-opts">
                  {MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </datalist>
              </div>
              <div style={s.row}>
                <span style={s.label}>Prompt</span>
                <textarea
                  style={{ ...s.input, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                />
              </div>
              <div style={s.row}>
                <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input type="checkbox" checked={editGraphTools} onChange={(e) => setEditGraphTools(e.target.checked)} />
                  Graph tools
                </label>
              </div>
            </>
          )}

          {editTaskType === 'command' && (
            <div style={s.row}>
              <span style={s.label}>Cmd</span>
              <textarea
                style={{ ...s.input, minHeight: 50, resize: 'vertical', fontFamily: 'monospace' }}
                value={editCommand}
                onChange={(e) => setEditCommand(e.target.value)}
              />
            </div>
          )}

          {/* Arguments */}
          <div style={{ ...s.sectionTitle, marginTop: '8px' }}>Arguments</div>
          {editArgs.map((arg, i) => (
            <div key={i} style={{ ...s.row, flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
              <input
                style={{ ...s.input, flex: '1 1 60px' }}
                placeholder="name"
                value={arg.name}
                onChange={(e) => updateArg(i, 'name', e.target.value)}
              />
              <select
                style={{ ...s.sel, flex: '0 0 auto' }}
                value={arg.arg_type}
                onChange={(e) => updateArg(i, 'arg_type', e.target.value)}
              >
                <option value="string">string</option>
                <option value="model_type">model_type</option>
              </select>
              <input
                style={{ ...s.input, flex: '1 1 60px' }}
                placeholder="default"
                value={arg.default_value}
                onChange={(e) => updateArg(i, 'default_value', e.target.value)}
              />
              <button style={s.removeBtn} onClick={() => removeArg(i)}>x</button>
            </div>
          ))}
          <button style={s.addBtn} onClick={addArg}>+ Add Argument</button>

          <button style={s.saveBtn} onClick={handleSave} disabled={mutating}>
            Save
          </button>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  headerBar: {
    display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 8px',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  select: {
    flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px', minWidth: 0,
  },
  iconBtn: {
    padding: '4px 8px', background: 'transparent', color: 'var(--text-dim)',
    border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer',
    fontSize: '14px', lineHeight: '1', flexShrink: 0,
  },
  editor: {
    flex: 1, overflowY: 'auto', padding: '8px 10px',
  },
  hint: {
    color: 'var(--text-muted)', fontSize: '10px', marginBottom: '8px', fontStyle: 'italic',
  },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: '6px', marginBottom: '4px',
  },
  label: {
    color: 'var(--text-dim)', flexShrink: 0, width: '42px', fontSize: '12px', paddingTop: '4px',
  },
  input: {
    flex: 1, padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  sel: {
    padding: '3px 7px', border: '1px solid var(--border)', borderRadius: '4px',
    background: 'var(--surface-2)', color: 'var(--text)', outline: 'none', fontSize: '12px',
  },
  sectionTitle: {
    color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: '4px',
  },
  addBtn: {
    background: 'transparent', color: 'var(--accent)', border: '1px solid var(--border)',
    borderRadius: '4px', cursor: 'pointer', fontSize: '11px', padding: '3px 8px', marginTop: '2px',
  },
  removeBtn: {
    background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)',
    borderRadius: '4px', cursor: 'pointer', fontSize: '11px', padding: '2px 6px', flexShrink: 0,
  },
  saveBtn: {
    marginTop: '10px', padding: '5px 12px', background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', width: '100%',
  },
}
