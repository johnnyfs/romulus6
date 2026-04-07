import { test, expect, type Page } from '@playwright/test'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000011'

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'Dispatch Workspace',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000012',
    workspace_id: WORKSPACE_ID,
    sandbox_id: '00000000-0000-0000-0000-000000000013',
    agent_type: 'opencode',
    model: 'anthropic/claude-sonnet-4-6',
    session_id: 'sess-1',
    status: 'busy',
    name: 'dispatched-agent',
    prompt: 'test prompt',
    graph_run_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
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

    if (path.endsWith('/graphs')) {
      return route.fulfill({ json: [] })
    }

    if (path.endsWith('/task-templates') || path.endsWith('/subgraph-templates')) {
      return route.fulfill({ json: [] })
    }

    return route.fulfill({ json: [] })
  })
}

test.describe('Agent Dispatch Form', () => {
  test('dispatches an opencode agent with only opencode-supported models', async ({ page }) => {
    await setupWorkspaceMocks(page)

    let payload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents`, async (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ json: [] })
      }
      payload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({
        status: 201,
        json: makeAgent(),
      })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)
    await page.getByRole('button', { name: '+ New agent' }).click()

    await expect(page.getByLabel('Type')).toHaveValue('opencode')
    await expect(page.getByLabel('Model')).toContainText('Claude Sonnet 4.6')
    await expect(page.getByLabel('Model')).not.toContainText('Gemini 2.5 Pro')
    await expect(page.getByText('Graph Editor')).toBeVisible()

    await page.getByLabel('Name (optional)').fill('Opencode Agent')
    await page.getByLabel('Prompt').fill('Summarize the repo briefly.')
    await page.getByLabel('Graph Editor').check()
    await page.getByRole('button', { name: 'Dispatch' }).click()

    expect(payload).toEqual({
      agent_type: 'opencode',
      model: 'anthropic/claude-sonnet-4-6',
      name: 'Opencode Agent',
      prompt: 'Summarize the repo briefly.',
      graph_tools: true,
    })
  })

  test('dispatches a pydantic agent with schema id and gemini-only models', async ({ page }) => {
    await setupWorkspaceMocks(page)

    let payload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents`, async (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ json: [] })
      }
      payload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({
        status: 201,
        json: makeAgent({
          id: '00000000-0000-0000-0000-000000000014',
          agent_type: 'pydantic',
          model: 'google/gemini-2.5-pro',
          name: 'Pydantic Agent',
        }),
      })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)
    await page.getByRole('button', { name: '+ New agent' }).click()
    await page.getByLabel('Type').selectOption('pydantic')

    await expect(page.getByLabel('Model')).toContainText('Gemini 2.5 Pro')
    await expect(page.getByLabel('Model')).not.toContainText('Claude Sonnet 4.6')
    await expect(page.getByLabel('Schema')).toBeVisible()
    await expect(page.getByText('Graph Editor')).toHaveCount(0)

    await page.getByLabel('Name (optional)').fill('Pydantic Agent')
    await page.getByLabel('Prompt').fill('Return a structured status update.')
    await page.getByRole('button', { name: 'Dispatch' }).click()

    expect(payload).toEqual({
      agent_type: 'pydantic',
      model: 'google/gemini-2.5-pro',
      name: 'Pydantic Agent',
      prompt: 'Return a structured status update.',
      schema_id: 'structured_response_v1',
    })
  })
})
