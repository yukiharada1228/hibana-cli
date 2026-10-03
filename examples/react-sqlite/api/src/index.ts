import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import type { Database } from '@yukiharada1228/hibana/database'

type Bindings = { DB: Database; FRONTEND_ORIGIN: string; API_TOKEN: string }
const app = new Hono<{ Bindings: Bindings }>()
app.use('*', (c, next) => cors({ origin: c.env.FRONTEND_ORIGIN, allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] })(c, next))
app.use('*', async (c, next) => {
  if (!c.env.API_TOKEN) return c.json({ error: 'API token is not configured' }, 503)
  return bearerAuth<{ Bindings: Bindings }>({ token: c.env.API_TOKEN })(c, next)
})
app.get('/notes', async c => c.json((await c.env.DB.prepare('SELECT id, title, completed FROM notes ORDER BY id DESC LIMIT 100').all()).results))
app.post('/notes', async c => {
  let input: unknown
  try { input = await c.req.json() }
  catch { return c.json({ error: 'Enter a valid JSON object' }, 400) }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('title' in input) || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200) return c.json({ error: 'Enter a title of 1–200 characters' }, 400)
  return c.json(await c.env.DB.prepare('INSERT INTO notes(title) VALUES (?) RETURNING id, title, completed').bind(input.title.trim()).first(), 201)
})
app.use('/notes/:id', async (c, next) => {
  if (!/^[1-9][0-9]*$/.test(c.req.param('id') ?? '') || !Number.isSafeInteger(Number(c.req.param('id')))) return c.json({ error: 'Invalid note ID' }, 400)
  await next()
})
app.patch('/notes/:id', async c => {
  const row = await c.env.DB.prepare('UPDATE notes SET completed=1-completed WHERE id=? RETURNING id, title, completed').bind(Number(c.req.param('id'))).first()
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404)
})
app.delete('/notes/:id', async c => {
  const row = await c.env.DB.prepare('DELETE FROM notes WHERE id=? RETURNING id').bind(Number(c.req.param('id'))).first()
  return row ? c.body(null, 204) : c.json({ error: 'Not found' }, 404)
})
export default app
