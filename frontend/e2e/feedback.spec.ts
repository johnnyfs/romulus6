import { test, expect, type Page, type Route } from '@playwright/test'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const AGENT_ID = '00000000-0000-0000-0000-000000000002'

const WORKSPACE = { id: WORKSPACE_ID, name: 'Test Workspace', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
const AGENT = {
  id: AGENT_ID,
  workspace_id: WORKSPACE_ID,
  sandbox_id: '00000000-0000-0000-0000-000000000003',
  agent_type: 'opencode' as const,
  model: 'anthropic/claude-sonnet-4-6',
  session_id: 'sess-1',
  status: 'busy' as const,
  name: 'test-agent',
  prompt: 'test',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function sseChunk(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

// Server-format event for workspace events stream/list
function serverEvent(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
) {
  return {
    id,
    session_id: 'sess-1',
    type,
    event_time: '2026-01-01T00:01:00Z',
    received_at: '2026-01-01T00:01:00Z',
    data,
    source_name: 'test-agent',
    agent_id: AGENT_ID,
    source_id: AGENT_ID,
    source_type: 'agent',
    workspace_id: WORKSPACE_ID,
  }
}

function feedbackRequestEvent(
  feedbackType: string,
  overrides: Record<string, unknown> = {},
) {
  return serverEvent(`fb-evt-${feedbackType}`, 'feedback.request', {
    feedback_id: `fb-${feedbackType}`,
    feedback_type: feedbackType,
    title: `Test ${feedbackType} title`,
    description: `Test ${feedbackType} description`,
    ...overrides,
  })
}

interface MockOptions {
  noSessionBusy?: boolean
  customSseEvents?: Record<string, unknown>[]
}

async function setupMocks(page: Page, sseEvents: Record<string, unknown>[] = [], opts: MockOptions = {}) {
  const streamEvents = opts.customSseEvents ?? sseEvents
  const appendBusy = !opts.noSessionBusy

  await page.route('**/api/workspaces/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // Workspace events SSE stream
    if (path.endsWith('/events/stream')) {
      let body = streamEvents.map((e) => sseChunk(e)).join('')
      if (appendBusy) body += sseChunk(serverEvent('session-busy', 'session.busy'))
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body,
      })
    }

    // Workspace events list (historical)
    if (path.endsWith('/events') && !path.includes('/agents/')) {
      return route.fulfill({ json: sseEvents })
    }

    // Agent events (non-stream, per-agent)
    if (path.includes(`/agents/${AGENT_ID}/events`)) {
      return route.fulfill({ json: [] })
    }

    // Feedback endpoint
    if (path.includes(`/agents/${AGENT_ID}/feedback`)) {
      return route.fulfill({ json: { accepted: true } })
    }

    // Agents list
    if (path.endsWith('/agents') && route.request().method() === 'GET') {
      return route.fulfill({ json: [AGENT] })
    }

    // Graphs
    if (path.endsWith('/graphs')) {
      return route.fulfill({ json: [] })
    }

    // Workspace detail
    if (path === `/api/workspaces/${WORKSPACE_ID}`) {
      return route.fulfill({ json: WORKSPACE })
    }

    // Fall through — return empty for any other API call
    return route.fulfill({ json: [] })
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Feedback Request - Approve/Reject', () => {
  test('renders approve card and submits approval', async ({ page }) => {
    const approveEvt = feedbackRequestEvent('approve', {
      context: { path: 'src/main.py', command: 'rm -rf /' },
    })
    await setupMocks(page, [approveEvt])

    let feedbackPayload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/feedback`, async (route) => {
      feedbackPayload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: { accepted: true } })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    // Card should render with title and description
    await expect(page.getByText('Test approve title')).toBeVisible()
    await expect(page.getByText('Test approve description')).toBeVisible()
    await expect(page.getByText('approval needed')).toBeVisible()

    // Context details
    await expect(page.getByText('src/main.py')).toBeVisible()
    await expect(page.getByText('$ rm -rf /')).toBeVisible()

    // Approve and Reject buttons visible
    const approveBtn = page.getByRole('button', { name: 'Approve' })
    const rejectBtn = page.getByRole('button', { name: 'Reject' })
    await expect(approveBtn).toBeVisible()
    await expect(rejectBtn).toBeVisible()

    // Click Approve
    await approveBtn.click()

    // Verify feedback payload
    expect(feedbackPayload).toEqual({
      feedback_id: 'fb-approve',
      feedback_type: 'approve',
      response: 'approved',
    })

    // After resolving, should show "Approved" label
    await expect(page.getByText('Approved')).toBeVisible()
    // Buttons should be gone
    await expect(approveBtn).not.toBeVisible()
  })

  test('renders approve card and submits rejection', async ({ page }) => {
    const approveEvt = feedbackRequestEvent('approve', {
      context: { path: 'src/danger.py' },
    })
    await setupMocks(page, [approveEvt])

    let feedbackPayload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/feedback`, async (route) => {
      feedbackPayload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: { accepted: true } })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    const rejectBtn = page.getByRole('button', { name: 'Reject' })
    await expect(rejectBtn).toBeVisible()
    await rejectBtn.click()

    expect(feedbackPayload).toEqual({
      feedback_id: 'fb-approve',
      feedback_type: 'approve',
      response: 'rejected',
    })

    await expect(page.getByText('Rejected')).toBeVisible()
  })
})

test.describe('Feedback Request - Select', () => {
  test('renders option buttons and submits selection', async ({ page }) => {
    const selectEvt = feedbackRequestEvent('select', {
      context: { options: ['Approach A: refactor', 'Approach B: rewrite'] },
    })
    await setupMocks(page, [selectEvt])

    let feedbackPayload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/feedback`, async (route) => {
      feedbackPayload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: { accepted: true } })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    await expect(page.getByText('choice needed')).toBeVisible()

    const optA = page.getByRole('button', { name: 'Approach A: refactor' })
    const optB = page.getByRole('button', { name: 'Approach B: rewrite' })
    await expect(optA).toBeVisible()
    await expect(optB).toBeVisible()

    // Select option B
    await optB.click()

    expect(feedbackPayload).toEqual({
      feedback_id: 'fb-select',
      feedback_type: 'select',
      response: 'Approach B: rewrite',
    })

    // Selected option should remain visible, unselected should be dimmed
    await expect(optB).toBeVisible()
  })
})

test.describe('Feedback Request - Input', () => {
  test('renders text input and submits response', async ({ page }) => {
    const inputEvt = feedbackRequestEvent('input', {
      context: { question: 'What should the module be named?' },
    })
    await setupMocks(page, [inputEvt])

    let feedbackPayload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/feedback`, async (route) => {
      feedbackPayload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: { accepted: true } })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    await expect(page.getByText('input needed')).toBeVisible()
    await expect(page.getByText('What should the module be named?')).toBeVisible()

    const textInput = page.getByPlaceholder('Type your response...')
    const submitBtn = page.getByRole('button', { name: 'Submit' })

    await expect(textInput).toBeVisible()
    await expect(submitBtn).toBeVisible()
    await expect(submitBtn).toBeDisabled()

    // Type and submit
    await textInput.fill('my_module')
    await expect(submitBtn).toBeEnabled()
    await submitBtn.click()

    expect(feedbackPayload).toEqual({
      feedback_id: 'fb-input',
      feedback_type: 'input',
      response: 'my_module',
    })

    // Should show the submitted value as resolved text
    await expect(page.getByText('my_module')).toBeVisible()
  })

  test('submits on Enter key', async ({ page }) => {
    const inputEvt = feedbackRequestEvent('input', {
      context: { question: 'Name?' },
    })
    await setupMocks(page, [inputEvt])

    let feedbackPayload: Record<string, unknown> | null = null
    await page.route(`**/api/workspaces/${WORKSPACE_ID}/agents/${AGENT_ID}/feedback`, async (route) => {
      feedbackPayload = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: { accepted: true } })
    })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    const textInput = page.getByPlaceholder('Type your response...')
    await textInput.fill('enter_test')
    await textInput.press('Enter')

    expect(feedbackPayload).toEqual({
      feedback_id: 'fb-input',
      feedback_type: 'input',
      response: 'enter_test',
    })
  })
})

test.describe('Feedback Request - Status bar', () => {
  test('shows "awaiting input" when agent is waiting', async ({ page }) => {
    const fbEvt = feedbackRequestEvent('approve', {
      context: { path: 'test.py' },
    })
    // Pass feedback event only — setupMocks won't append session.busy for this
    // since we override with a custom handler below
    await setupMocks(page, [], { noSessionBusy: true, customSseEvents: [fbEvt] })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    // Status bar should show "awaiting input"
    await expect(page.getByText('awaiting input')).toBeVisible()
  })
})

test.describe('Feedback Request - Disabled on terminal agent', () => {
  test('feedback card is disabled when agent terminates', async ({ page }) => {
    const fbEvt = feedbackRequestEvent('approve', {
      context: { path: 'test.py' },
    })
    const errEvt = serverEvent('session-err', 'session.error')

    // Send feedback.request then session.error — no trailing session.busy
    await setupMocks(page, [], { noSessionBusy: true, customSseEvents: [fbEvt, errEvt] })

    await page.goto(`/workspaces/${WORKSPACE_ID}`)

    // Card should render
    await expect(page.getByText('Test approve title')).toBeVisible()

    // Buttons should be disabled (agent is terminal)
    const approveBtn = page.getByRole('button', { name: 'Approve' })
    await expect(approveBtn).toBeDisabled()
  })
})
