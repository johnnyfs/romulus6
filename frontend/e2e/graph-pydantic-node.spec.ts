import { expect, test, type Page } from '@playwright/test'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000021'
const GRAPH_ID = '00000000-0000-0000-0000-000000000022'
const NODE_ID = '00000000-0000-0000-0000-000000000023'

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'Graph Workspace',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const GRAPH = {
  id: GRAPH_ID,
  workspace_id: WORKSPACE_ID,
  name: 'Demo Graph',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const GRAPH_DETAIL = {
  ...GRAPH,
  nodes: [
    {
      id: NODE_ID,
      graph_id: GRAPH_ID,
      node_type: 'agent',
      name: 'image crop',
      agent_config: {
        agent_type: 'opencode',
        model: 'anthropic/claude-sonnet-4-6',
        prompt: 'Initial prompt',
        graph_tools: true,
      },
      command_config: null,
      task_template_id: null,
      subgraph_template_id: null,
      argument_bindings: null,
      output_schema: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
  edges: [],
}

async function setupWorkspaceMocks(page: Page) {
  await page.route('**/api/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

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

    if (path.endsWith('/agents') && route.request().method() === 'GET') {
      return route.fulfill({ json: [] })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/graphs`) {
      return route.fulfill({ json: [GRAPH] })
    }

    if (path === `/api/workspaces/${WORKSPACE_ID}/graphs/${GRAPH_ID}`) {
      return route.fulfill({ json: GRAPH_DETAIL })
    }

    if (path.endsWith('/task-templates') || path.endsWith('/subgraph-templates')) {
      return route.fulfill({ json: [] })
    }

    return route.fulfill({ json: [] })
  })
}

test('graph nodes can be saved as pydantic with output schema', async ({ page }) => {
  await setupWorkspaceMocks(page)

  let payload: Record<string, unknown> | null = null
  await page.route(`**/api/workspaces/${WORKSPACE_ID}/graphs/${GRAPH_ID}/nodes/${NODE_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      return route.fallback()
    }
    payload = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      status: 200,
      json: {
        ...GRAPH_DETAIL.nodes[0],
        agent_config: {
          agent_type: 'pydantic',
          model: 'google/gemini-2.5-pro',
          prompt: 'Return crop coordinates.',
        },
        output_schema: {
          crop_left: 'number',
        },
      },
    })
  })

  page.on('dialog', (dialog) => dialog.accept('crop_left'))

  await page.goto(`/workspaces/${WORKSPACE_ID}`)
  await page.getByText('image crop').click()

  const agentTypeSelect = page.locator('#graph-node-agent-type')
  const promptArea = page.locator('#graph-node-prompt')

  await agentTypeSelect.evaluate((element: Element) => {
    const select = element as HTMLSelectElement
    select.value = 'pydantic'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await promptArea.fill('Return crop coordinates.')
  await page.getByRole('button', { name: '[ + Add Field ]' }).click()
  await page.getByRole('button', { name: 'Save' }).click()

  expect(payload).toEqual({
    name: 'image crop',
    node_type: 'agent',
    agent_config: {
      agent_type: 'pydantic',
      model: 'google/gemini-2.5-pro',
      prompt: 'Return crop coordinates.',
    },
    output_schema: {
      crop_left: 'string',
    },
  })
})
