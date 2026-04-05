import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import WorkspacesPage from './pages/WorkspacesPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/workspaces" replace />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
      </Routes>
    </BrowserRouter>
  )
}
