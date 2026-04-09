# Frontend

React 19 + React Router 7 + Vite 8 + TypeScript.

## Dev

    npm run dev      # start dev server
    npm run build    # type-check + production build
    npm run lint     # eslint (must pass before merge)

## React Rules We Enforce

These are the patterns that have caused production bugs in this codebase. Follow them.

### Never swallow errors silently

    // BAD — hides bugs, causes blank screens
    .catch(() => {})
    try { ... } catch {}

    // GOOD — at minimum log, ideally surface to user
    .catch((err) => { console.warn('stream error', err); setPageError(err.message) })

ESLint `no-empty` with `allowEmptyCatch: false` enforces this.

### Always include correct useEffect dependencies

Never add `eslint-disable-next-line react-hooks/exhaustive-deps`. If the deps
feel wrong, fix the code — use refs for values you don't want to trigger
re-runs, or use the function form of state setters to avoid depending on
current state.

    // BAD — reads searchParams but doesn't depend on it
    useEffect(() => {
      if (searchParams.get('tab') == null) setSearchParams(...)
    }, [id]) // eslint-disable-next-line react-hooks/exhaustive-deps

    // GOOD — use the setter's function form
    useEffect(() => {
      setSearchParams((prev) => {
        if (prev.get('tab') != null) return prev
        return mergeSearchParams(prev, { tab: 'activity' })
      }, { replace: true })
    }, [id, setSearchParams])

### Use stable keys in lists, never array index for dynamic lists

    // BAD — adding/removing items corrupts component state
    images.map((img, idx) => <img key={idx} />)

    // GOOD — use a content-derived or pre-assigned stable ID
    images.map((img) => <img key={img.id} />)

Array index is only safe for static, never-reordered lists.

### Wrap independent UI regions in ErrorBoundary

A single error boundary at the app root means one bad event crashes the
entire page. Wrap panels, feed sections, and other independent zones in
their own `<ErrorBoundary>` so failures are isolated.

### SSE / streaming connections must reconnect

Never assume a stream stays alive forever. Streams die on network blips,
backend restarts, and deploys. Always implement:
- Auto-reconnect with exponential backoff
- A visible connection status indicator
- Error surfacing (not silent catch)

### Polling intervals must guard against overlap

    // BAD — if the request takes >2s, requests pile up
    setInterval(async () => { await fetchData() }, 2000)

    // GOOD — skip if previous request still in flight
    setInterval(async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try { await fetchData() } finally { inFlightRef.current = false }
    }, 2000)

### Auto-scroll should respect user position

Only auto-scroll to bottom when the user is already near the bottom.
If they've scrolled up to read history, don't yank them down on every
new event.

## Architecture Notes

- **No global state library** — React hooks + local state is sufficient for this app size
- **SSE for real-time events** — workspace events stream via Server-Sent Events, not polling
- **URL-driven state** — tab selection, graph/run/node IDs are stored in search params
- **ErrorBoundary** — class component at `src/components/ErrorBoundary.tsx`, supports `resetKey` prop
