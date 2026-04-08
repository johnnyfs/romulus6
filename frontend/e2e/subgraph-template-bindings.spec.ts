import { expect, test, type Page } from '@playwright/test'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000031'
const SUBGRAPH_ID = '00000000-0000-0000-0000-000000000032'
const NODE_ID = '00000000-0000-0000-0000-000000000033'
const TASK_TEMPLATE_ID = '00000000-0000-0000-0000-000000000034'

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'Template Workspace',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const TASK_TEMPLATE = {
  id: TASK_TEMPLATE_ID,
  workspace_id: WORKSPACE_ID,
  name: 'Task With Bar',
  label: null,
  task_type: 'command',
  agent_type: null,
  model: null,
  prompt: null,
  command: 'echo {{ bar }}',
  graph_tools: false,
  arguments: [
    {
      id: '00000000-0000-0000-0000-000000000035',
      name: 'bar',
      arg_type: 'string',
      default_value: null,
      model_constraint: null,
      min_value: null,
      max_value: null,
      enum_options: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makeDetail(
  options: {
    arguments?: Array<{ id: string; name: string; arg_type: string }>
    nodeType?: 'agent' | 'task_template'
    taskTemplateId?: string | null
    argumentBindings?: Record<string, string> | null
  } = {},
) {
  return {
    id: SUBGRAPH_ID,
    workspace_id: WORKSPACE_ID,
    name: 'Outer Subgraph',
    label: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    arguments: (options.arguments ?? []).map((arg) => ({
      ...arg,
      default_value: null,
      model_constraint: null,
      min_value: null,
      max_value: null,
      enum_options: null,
      created_at: '2026-01-01T00:00:00Z',
    })),
    nodes: [
      {
        id: NODE_ID,
        subgraph_template_id: SUBGRAPH_ID,
        node_type: options.nodeType ?? 'agent',
        name: 'Inner Task',
        agent_config: {
          agent_type: 'opencode',
          model: 'anthropic/claude-haiku-4-5',
          prompt: 'initial prompt',
          graph_tools: false,
        },
        command_config: null,
        task_template_id: options.taskTemplateId ?? null,
        ref_subgraph_template_id: null,
        argument_bindings: options.argumentBindings ?? null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    edges: [],
  }
}

async function setupWorkspaceMocks(page: Page) {
  let currentDetail = makeDetail()

  await page.route('**/api/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === `/api/workspaces/${WORKSPACE_ID}`) {
      return route.fulfill({ json: WORKSPACE })
    }

    if (path.endsWith('/events/stream')) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: '',
      })
    }

    if (path.endsWith('/events')) {
      return route.fulfill({ json: [] })
    }

    if (path.endsWith('/agents') && method === 'GET') {
      return route.fulfill({ json: [] })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/graphs`) {
      return route.fulfill({ json: [] })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/task-templates`) {
      return route.fulfill({ json: [TASK_TEMPLATE] })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/task-templates/${TASK_TEMPLATE_ID}`) {
      return route.fulfill({ json: TASK_TEMPLATE })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/subgraph-templates` && method === 'GET') {
      return route.fulfill({
        json: [{ id: SUBGRAPH_ID, workspace_id: WORKSPACE_ID, name: 'Outer Subgraph', label: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
      })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/subgraph-templates/${SUBGRAPH_ID}` && method === 'GET') {
      return route.fulfill({ json: currentDetail })
    }

    return route.fallback()
  })

  return {
    getCurrentDetail: () => currentDetail,
    setCurrentDetail: (next: ReturnType<typeof makeDetail>) => {
      currentDetail = next
    },
  }
}

test('subgraph template task bindings preserve parent argument references', async ({ page }) => {
  const state = await setupWorkspaceMocks(page)

  let savedTemplatePayload: Record<string, unknown> | null = null
  let savedNodePayload: Record<string, unknown> | null = null

  await page.route(`**/api/workspaces/${WORKSPACE_ID}/subgraph-templates/${SUBGRAPH_ID}`, async (route) => {
    if (route.request().method() !== 'PUT') {
      return route.fallback()
    }
    savedTemplatePayload = JSON.parse(route.request().postData() ?? '{}')
    state.setCurrentDetail(
      makeDetail({
        arguments: [
          {
            id: '00000000-0000-0000-0000-000000000036',
            name: 'foo',
            arg_type: 'string',
          },
        ],
      }),
    )
    await route.fulfill({ status: 200, json: state.getCurrentDetail() })
  })

  await page.route(`**/api/workspaces/${WORKSPACE_ID}/subgraph-templates/${SUBGRAPH_ID}/nodes/${NODE_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      return route.fallback()
    }
    savedNodePayload = JSON.parse(route.request().postData() ?? '{}')
    state.setCurrentDetail(
      makeDetail({
        arguments: [
          {
            id: '00000000-0000-0000-0000-000000000036',
            name: 'foo',
            arg_type: 'string',
          },
        ],
        nodeType: 'task_template',
        taskTemplateId: TASK_TEMPLATE_ID,
        argumentBindings: { bar: '{{ foo }}' },
      }),
    )
    await route.fulfill({
      status: 200,
      json: state.getCurrentDetail().nodes[0],
    })
  })

  await page.goto(`/workspaces/${WORKSPACE_ID}`)
  await page.getByRole('button', { name: 'TEMPLATES' }).click()
  await page.getByRole('button', { name: 'Subgraphs' }).click()

  await page.getByText('Arguments (0)').click()
  await page.getByRole('button', { name: '+ Add' }).click()
  const argInputs = page.locator('input[placeholder="name"]')
  await argInputs.first().fill('foo')
  await page.locator('button', { hasText: 'Save' }).first().click()
  await expect(page.getByText('Arguments (1)')).toBeVisible()

  await page.getByText('Inner Task').click()
  const inspector = page.locator('text=NODE').locator('..')
  await inspector.locator('select').first().selectOption('task_template')
  await inspector.locator('select').nth(1).selectOption(TASK_TEMPLATE_ID)
  const bindingInput = inspector.locator('input[placeholder="{{ bar }}"]')
  await bindingInput.fill('{{ foo }}')
  await inspector.getByRole('button', { name: 'Save' }).click()

  expect(savedTemplatePayload).toEqual({
    name: 'Outer Subgraph',
    nodes: [
      {
        name: 'Inner Task',
        node_type: 'agent',
        agent_config: {
          agent_type: 'opencode',
          model: 'anthropic/claude-haiku-4-5',
          prompt: 'initial prompt',
          graph_tools: false,
        },
      },
    ],
    edges: [],
    arguments: [
      {
        name: 'foo',
        arg_type: 'string',
      },
    ],
  })

  expect(savedNodePayload).toEqual({
    name: 'Inner Task',
    node_type: 'task_template',
    task_template_id: TASK_TEMPLATE_ID,
    argument_bindings: {
      bar: '{{ foo }}',
    },
  })
})
