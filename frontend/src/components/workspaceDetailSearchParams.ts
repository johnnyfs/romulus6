export type WorkspacePanelTab = 'graph' | 'runs' | 'templates'
export type WorkspaceDetailTab = 'activity' | 'sandboxes'
export type TemplatesSubTab = 'tasks' | 'subgraphs' | 'schemas'

export const WORKSPACE_DETAIL_PARAM_KEYS = {
  agentId: 'agent',
  graphId: 'graph',
  graphNodeId: 'graphNode',
  panelTab: 'panel',
  workspaceTab: 'tab',
  runGraphId: 'runGraph',
  runId: 'run',
  runNodeId: 'runNode',
  showDismissedAgents: 'showDismissedAgents',
  showDeadMessages: 'showDead',
  taskTemplateId: 'taskTemplate',
  templatesSubTab: 'templatesTab',
  templateNodeId: 'templateNode',
  subgraphTemplateId: 'subgraphTemplate',
  schemaTemplateId: 'schemaTemplate',
  hideFailedWorkers: 'hideFailed',
} as const

type SearchParamValue = string | null | undefined

export function mergeSearchParams(
  current: URLSearchParams,
  updates: Record<string, SearchParamValue>,
): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
  }
  return next
}

export function readEnumParam<T extends string>(
  params: URLSearchParams,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = params.get(key)
  return value && values.includes(value as T) ? (value as T) : fallback
}

export function readStringParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  return value && value.trim() ? value : null
}

export function readBooleanParam(
  params: URLSearchParams,
  key: string,
  fallback: boolean,
): boolean {
  const value = params.get(key)
  if (value === '1') return true
  if (value === '0') return false
  return fallback
}
