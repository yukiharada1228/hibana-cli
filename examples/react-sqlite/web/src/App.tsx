import { useState, type FormEvent } from 'react'

type Note = { id: number; title: string; completed: number }
const base = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
export default function App() {
  const [token, setToken] = useState('')
  const [notes, setNotes] = useState<Note[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function request(path: string, method = 'GET', body?: object) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    return response.status === 204 ? undefined : response.json()
  }
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await operation(); setNotes(await request('/notes')) }
    catch (error) { setError(error instanceof Error ? error.message : 'Request failed') }
    finally { setBusy(false) }
  }
  function add(event: FormEvent) {
    event.preventDefault()
    void perform(async () => { await request('/notes', 'POST', { title }); setTitle('') })
  }
  return <main><p className="eyebrow">HIBANA NOTES</p><h1>Make room for your ideas.</h1>
    <label>API token <input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
    <button disabled={busy || !token} onClick={() => void perform(async () => {})}>Load notes</button>
    <form onSubmit={add}><label>New note <input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label><button disabled={busy || !token}>Add note</button></form>
    {error && <p role="alert">{error}</p>}
    <ul>{notes.map(note => <li key={note.id}><label><input type="checkbox" disabled={busy} checked={Boolean(note.completed)} onChange={() => void perform(() => request(`/notes/${note.id}`, 'PATCH'))} />{note.title}</label><button disabled={busy} onClick={() => void perform(() => request(`/notes/${note.id}`, 'DELETE'))}>Delete</button></li>)}</ul>
    <p>The token stays in this browser tab's memory. Reloading clears it.</p>
  </main>
}
