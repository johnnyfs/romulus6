import { useMemo } from 'react'
import type { SchemaTemplate } from '../api/templates'
import {
  CONTAINER_OPTIONS,
  buildBaseTypeOptions,
  composeTypeValue,
  parseTypeValue,
} from '../api/templates'

interface TypeSelectorProps {
  value: string
  onChange: (value: string) => void
  schemaTemplates: SchemaTemplate[]
  excludeSchemaId?: string
  selectStyle?: React.CSSProperties
}

export default function TypeSelector({
  value,
  onChange,
  schemaTemplates,
  excludeSchemaId,
  selectStyle,
}: TypeSelectorProps) {
  const { container, base } = parseTypeValue(value)
  const baseOptions = useMemo(
    () => buildBaseTypeOptions(schemaTemplates, excludeSchemaId),
    [schemaTemplates, excludeSchemaId],
  )

  return (
    <>
      <select
        style={selectStyle}
        value={container}
        onChange={(e) => onChange(composeTypeValue(e.target.value as any, base))}
      >
        {CONTAINER_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <select
        style={selectStyle}
        value={base}
        onChange={(e) => onChange(composeTypeValue(container, e.target.value))}
      >
        {baseOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </>
  )
}
