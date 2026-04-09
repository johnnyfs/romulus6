import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAutoResize } from '../hooks/useAutoResize'
import { useSearchParams } from 'react-router-dom'
import type { NodeType } from '../api/graphs'
import { DEFAULT_MODEL_BY_AGENT_TYPE, SUPPORTED_MODELS_BY_AGENT_TYPE, type AgentType } from '../api/models'
import {
  type TaskTemplate,
  type TaskTemplateArgType,
  createTaskTemplate,
  deleteTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  updateTaskTemplate,
} from '../api/templates'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readStringParam,
} from './workspaceDetailSearchParams'

const OUTPUT_FIELD_TYPES = ['string', 'number', 'boolean'] as const

export default function TaskTemplatesPanel({ workspaceId }: { workspaceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [detail, setDetail] = useState<TaskTemplate | null>(null)
  const [mutating, setMutating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const activeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.taskTemplateId)

  // Edit state
  const [editName, setEditName] = useState('')
  const [editLabel, setEditLabel] = useState('')
  const [editTaskType, setEditTaskType] = useState<NodeType>('agent')
  const [editAgentType, setEditAgentType] = useState<AgentType>('opencode')
  const [editModel, setEditModel] = useState(DEFAULT_MODEL_BY_AGENT_TYPE.opencode)
  const [editPrompt, setEditPrompt] = useState('')
  const [editCommand, setEditCommand] = useState('')
  const promptRef = useAutoResize(editPrompt, 300, 50)
  const commandRef = useAutoResize(editCommand, 300, 50)
  const [editGraphTools, setEditGraphTools] = useState(false)
  const argIdCounter = useRef(0)
  const [editArgs, setEditArgs] = useState<{ _id: number; name: string; arg_type: TaskTemplateArgType; default_value: string; model_constraint: string[]; min_value: string; max_value: string; enum_options: string[] }[]>([])
  const [editOutputSchema, setEditOutputSchema] = useState<Record<string, string>>({})
  const modelOptions = useMemo(() => SUPPORTED_MODELS_BY_AGENT_TYPE[editAgentType], [editAgentType])

  function markDirty<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setDirty(true) }
  }

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

  const setActiveId = useCallback(
    (templateId: string | null, replace = false) => {
      setSearchParams(
        (prev) =>
          mergeSearchParams(prev, {
            [WORKSPACE_DETAIL_PARAM_KEYS.taskTemplateId]: templateId,
          }),
        { replace },
      )
    },
    [setSearchParams],
  )

  // Load templates on mount / workspace change
  useEffect(() => {
    loadList()
  }, [loadList])

  // Auto-select first template if current selection is invalid
  useEffect(() => {
    if (templates.length === 0) return
    const hasActive = !!activeId && templates.some((t) => t.id === activeId)
    if (!hasActive) {
      setActiveId(templates[0]?.id ?? null, true)
    }
  }, [templates, activeId, setActiveId])

  useEffect(() => {
    if (activeId && templates.some((template) => template.id === activeId)) {
      loadDetail(activeId).then((t) => {
        setEditName(t.name)
        setEditLabel(t.label ?? '')
        setEditTaskType(t.task_type)
        const agType = (t.agent_type ?? 'opencode') as AgentType
        setEditAgentType(agType)
        setEditModel(t.model ?? DEFAULT_MODEL_BY_AGENT_TYPE[agType])
        setEditPrompt(t.prompt ?? '')
        setEditCommand(t.command ?? '')
        setEditGraphTools(t.graph_tools)
        setEditOutputSchema(t.output_schema ?? {})
        setEditArgs(
          t.arguments.map((a) => ({
            _id: argIdCounter.current++,
            name: a.name,
            arg_type: a.arg_type,
            default_value: a.default_value ?? '',
            model_constraint: a.model_constraint ?? [],
            min_value: a.min_value != null ? String(a.min_value) : '',
            max_value: a.max_value != null ? String(a.max_value) : '',
            enum_options: a.enum_options ?? [],
          })),
        )
        setDirty(false)
      })
    } else {
      setDetail(null)
    }
  }, [activeId, loadDetail, templates])

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
        label: editLabel || undefined,
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
          min_value: a.min_value ? parseFloat(a.min_value) : undefined,
          max_value: a.max_value ? parseFloat(a.max_value) : undefined,
          enum_options: a.enum_options.length > 0 ? a.enum_options : undefined,
        })),
        output_schema: Object.keys(editOutputSchema).length > 0 ? editOutputSchema : undefined,
      })
      await loadList()
      await loadDetail(activeId)
    } finally {
      setMutating(false)
    }
  }

  function addArg() {
    setEditArgs([...editArgs, { _id: argIdCounter.current++, name: '', arg_type: 'string', default_value: '', model_constraint: [], min_value: '', max_value: '', enum_options: [] }])
    setDirty(true)
  }

  function removeArg(idx: number) {
    setEditArgs(editArgs.filter((_, i) => i !== idx))
    setDirty(true)
  }

  function updateArg(idx: number, field: string, value: any) {
    setEditArgs(editArgs.map((a, i) => (i === idx ? { ...a, [field]: value } : a)))
    setDirty(true)
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
            <input style={s.input} value={editName} onChange={(e) => markDirty(setEditName)(e.target.value)} />
          </div>

          <div style={s.row}>
            <span style={s.label}>Label</span>
            <input style={s.input} value={editLabel} onChange={(e) => markDirty(setEditLabel)(e.target.value)} placeholder="e.g. Process {{ item }}" />
          </div>

          <div style={s.row}>
            <span style={s.label}>Type</span>
            <select style={s.sel} value={editTaskType} onChange={(e) => markDirty(setEditTaskType)(e.target.value as NodeType)}>
              <option value="agent">agent</option>
              <option value="command">command</option>
            </select>
          </div>

          {editTaskType === 'agent' && (
            <>
              <div style={s.row}>
                <span style={s.label}>Agent</span>
                <select style={s.sel} value={editAgentType}
                  onChange={(e) => {
                    const nextType = e.target.value as AgentType
                    markDirty(setEditAgentType)(nextType)
                    setEditModel(DEFAULT_MODEL_BY_AGENT_TYPE[nextType])
                    if (nextType !== 'opencode' && nextType !== 'claude_code') setEditGraphTools(false)
                  }}>
                  <option value="opencode">opencode</option>
                  <option value="pydantic">pydantic</option>
                  <option value="claude_code">claude_code</option>
                </select>
              </div>
              <div style={s.row}>
                <span style={s.label}>Model</span>
                <select style={s.sel} value={editModel} onChange={(e) => markDirty(setEditModel)(e.target.value)}>
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div style={s.row}>
                <span style={s.label}>Prompt</span>
                <textarea
                  ref={promptRef}
                  style={{ ...s.input, minHeight: 50, resize: 'none', fontFamily: 'inherit' }}
                  value={editPrompt}
                  onChange={(e) => markDirty(setEditPrompt)(e.target.value)}
                />
              </div>
              {(editAgentType === 'opencode' || editAgentType === 'claude_code') && (
                <div style={s.row}>
                  <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input type="checkbox" checked={editGraphTools} onChange={(e) => markDirty(setEditGraphTools)(e.target.checked)} />
                    Graph tools
                  </label>
                </div>
              )}
            </>
          )}

          {editTaskType === 'command' && (
            <div style={s.row}>
              <span style={s.label}>Cmd</span>
              <textarea
                ref={commandRef}
                style={{ ...s.input, minHeight: 50, resize: 'none', fontFamily: 'monospace' }}
                value={editCommand}
                onChange={(e) => markDirty(setEditCommand)(e.target.value)}
              />
            </div>
          )}

          {/* Arguments */}
          <div style={{ ...s.sectionTitle, marginTop: '8px' }}>Arguments</div>
          {editArgs.map((arg, i) => (
            <div key={arg._id} style={{ ...s.row, flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
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
                <option value="boolean">boolean</option>
                <option value="number">number</option>
                <option value="enum">enum</option>
              </select>
              <input
                style={{ ...s.input, flex: '1 1 60px' }}
                placeholder="default"
                value={arg.default_value}
                onChange={(e) => updateArg(i, 'default_value', e.target.value)}
              />
              <button style={s.removeBtn} onClick={() => removeArg(i)}>x</button>
              {arg.arg_type === 'number' && (
                <div style={{ display: 'flex', gap: '4px', width: '100%' }}>
                  <input
                    style={{ ...s.input, flex: 1 }}
                    placeholder="min"
                    type="number"
                    value={arg.min_value}
                    onChange={(e) => updateArg(i, 'min_value', e.target.value)}
                  />
                  <input
                    style={{ ...s.input, flex: 1 }}
                    placeholder="max"
                    type="number"
                    value={arg.max_value}
                    onChange={(e) => updateArg(i, 'max_value', e.target.value)}
                  />
                </div>
              )}
              {arg.arg_type === 'enum' && (
                <input
                  style={{ ...s.input, width: '100%' }}
                  placeholder="options (comma-separated)"
                  value={arg.enum_options.join(', ')}
                  onChange={(e) => updateArg(i, 'enum_options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                />
              )}
            </div>
          ))}
          <button style={s.addBtn} onClick={addArg}>+ Add Argument</button>

          {/* Output Schema */}
          <div style={{ ...s.sectionTitle, marginTop: '8px' }}>Output Schema</div>
          {Object.entries(editOutputSchema).map(([field, type]) => (
            <div key={field} style={{ ...s.row, gap: '4px' }}>
              <input style={{ ...s.input, flex: 2 }} value={field} readOnly title={field} />
              <select style={{ ...s.sel, flex: 1 }} value={type}
                onChange={(e) => {
                  setEditOutputSchema(prev => ({ ...prev, [field]: e.target.value }))
                  setDirty(true)
                }}>
                {OUTPUT_FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button style={s.removeBtn}
                onClick={() => {
                  setEditOutputSchema(prev => {
                    const next = { ...prev }
                    delete next[field]
                    return next
                  })
                  setDirty(true)
                }}>x</button>
            </div>
          ))}
          <button style={s.addBtn} onClick={() => {
            const name = window.prompt('Field name:')
            if (!name?.trim()) return
            setEditOutputSchema(prev => ({ ...prev, [name.trim()]: 'string' }))
            setDirty(true)
          }}>+ Add Field</button>

          <button style={{ ...s.saveBtn, opacity: dirty ? 1 : 0.5 }} onClick={handleSave} disabled={mutating || !dirty}>
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
