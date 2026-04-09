import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  type SchemaTemplate,
  buildTypeOptions,
  createSchemaTemplate,
  deleteSchemaTemplate,
  listSchemaTemplates,
  updateSchemaTemplate,
} from '../api/templates'
import {
  WORKSPACE_DETAIL_PARAM_KEYS,
  mergeSearchParams,
  readStringParam,
} from './workspaceDetailSearchParams'

export default function SchemaTemplatesPanel({ workspaceId }: { workspaceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [templates, setTemplates] = useState<SchemaTemplate[]>([])
  const [mutating, setMutating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const activeId = readStringParam(searchParams, WORKSPACE_DETAIL_PARAM_KEYS.schemaTemplateId)

  // Edit state
  const [editName, setEditName] = useState('')
  const fieldIdCounter = useRef(0)
  const [editFields, setEditFields] = useState<{ _id: number; name: string; type: string }[]>([])

  function markDirty<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setDirty(true) }
  }

  const loadList = useCallback(async () => {
    const ts = await listSchemaTemplates(workspaceId)
    setTemplates(ts)
    return ts
  }, [workspaceId])

  const setActiveId = useCallback(
    (templateId: string | null, replace = false) => {
      setSearchParams(
        (prev) =>
          mergeSearchParams(prev, {
            [WORKSPACE_DETAIL_PARAM_KEYS.schemaTemplateId]: templateId,
          }),
        { replace },
      )
    },
    [setSearchParams],
  )

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    if (templates.length === 0) return
    const hasActive = !!activeId && templates.some((t) => t.id === activeId)
    if (!hasActive) {
      setActiveId(templates[0]?.id ?? null, true)
    }
  }, [templates, activeId, setActiveId])

  useEffect(() => {
    const tmpl = templates.find(t => t.id === activeId)
    if (tmpl) {
      setEditName(tmpl.name)
      setEditFields(
        Object.entries(tmpl.fields ?? {}).map(([name, type]) => ({
          _id: fieldIdCounter.current++,
          name,
          type,
        }))
      )
      setDirty(false)
    }
  }, [activeId, templates])

  async function handleCreate() {
    const name = window.prompt('Schema name:')
    if (!name?.trim()) return
    setMutating(true)
    try {
      const t = await createSchemaTemplate(workspaceId, {
        name: name.trim(),
        fields: { field_1: 'string' },
      })
      await loadList()
      setActiveId(t.id)
    } finally {
      setMutating(false)
    }
  }

  async function handleDelete() {
    if (!activeId) return
    if (!window.confirm('Delete this schema template?')) return
    setMutating(true)
    try {
      await deleteSchemaTemplate(workspaceId, activeId)
      const ts = await loadList()
      setActiveId(ts.length > 0 ? ts[0].id : null)
    } catch (e: any) {
      alert(e.message || 'Failed to delete')
    } finally {
      setMutating(false)
    }
  }

  async function handleSave() {
    if (!activeId) return
    setMutating(true)
    try {
      const fields: Record<string, string> = {}
      for (const f of editFields) {
        if (f.name.trim()) fields[f.name.trim()] = f.type
      }
      await updateSchemaTemplate(workspaceId, activeId, {
        name: editName,
        fields,
      })
      await loadList()
      setDirty(false)
    } catch (e: any) {
      alert(e.message || 'Failed to save')
    } finally {
      setMutating(false)
    }
  }

  function addField() {
    setEditFields(prev => [...prev, { _id: fieldIdCounter.current++, name: '', type: 'string' }])
    setDirty(true)
  }

  function removeField(index: number) {
    setEditFields(prev => prev.filter((_, i) => i !== index))
    setDirty(true)
  }

  function updateField(index: number, key: 'name' | 'type', value: string) {
    setEditFields(prev => prev.map((f, i) => i === index ? { ...f, [key]: value } : f))
    setDirty(true)
  }

  // Build type options excluding the current schema to prevent self-reference
  const typeOptions = buildTypeOptions(templates, activeId ?? undefined)

  const active = templates.find(t => t.id === activeId)

  return (
    <div style={s.wrap}>
      <div style={s.headerBar}>
        <select
          style={s.select}
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value || null)}
        >
          {templates.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <button style={s.iconBtn} onClick={handleCreate} disabled={mutating} title="New schema">+</button>
        <button style={s.iconBtn} onClick={handleDelete} disabled={mutating || !activeId} title="Delete schema">-</button>
      </div>

      {active && (
        <div style={s.editor}>
          <div style={s.row}>
            <span style={s.label}>Name</span>
            <input
              style={s.input}
              value={editName}
              onChange={(e) => markDirty(setEditName)(e.target.value)}
            />
          </div>

          <div style={{ ...s.sectionTitle, marginTop: '8px' }}>Fields</div>
          {editFields.map((field, i) => (
            <div key={field._id} style={{ ...s.row, gap: '4px', marginBottom: '4px' }}>
              <input
                style={{ ...s.input, flex: '1 1 80px' }}
                placeholder="field name"
                value={field.name}
                onChange={(e) => updateField(i, 'name', e.target.value)}
              />
              <select
                style={{ ...s.sel, flex: '1 1 100px' }}
                value={field.type}
                onChange={(e) => updateField(i, 'type', e.target.value)}
              >
                {typeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button style={s.removeBtn} onClick={() => removeField(i)}>x</button>
            </div>
          ))}
          <button style={s.addBtn} onClick={addField}>+ Add Field</button>

          <button
            style={{ ...s.saveBtn, opacity: dirty ? 1 : 0.5 }}
            onClick={handleSave}
            disabled={mutating || !dirty}
          >
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
