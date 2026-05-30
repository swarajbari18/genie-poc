import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { log } from '../lib/logger.js';
const projectsRouter = new Hono();
// GET /api/projects — list projects with contract summaries
projectsRouter.get('/', requireAuth, async (c) => {
    const user = c.get('user');
    const rows = await db.execute(sql `
    SELECT
      p.id,
      p.name,
      p.description,
      p.created_at AS "createdAt",
      p.updated_at AS "updatedAt",
      COALESCE(
        json_agg(
          jsonb_build_object(
            'id',            c.id,
            'title',         c.title,
            'status',        c.status,
            'recipientName', c.recipient_name,
            'recipientEmail',c.recipient_email,
            'sentAt',        c.sent_at,
            'updatedAt',     c.updated_at
          ) ORDER BY c.updated_at DESC
        ) FILTER (WHERE c.id IS NOT NULL),
        '[]'::json
      ) AS contracts
    FROM projects p
    LEFT JOIN contracts c ON c.project_id = p.id AND c.user_id = ${user.id}
    WHERE p.user_id = ${user.id}
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `);
    return c.json({ projects: rows });
});
// POST /api/projects — create a project
projectsRouter.post('/', requireAuth, async (c) => {
    const user = c.get('user');
    const { name, description } = await c.req.json();
    if (!name?.trim())
        return c.json({ error: 'Name required' }, 400);
    const [project] = await db
        .insert(projects)
        .values({ userId: user.id, name: name.trim(), description: description?.trim() ?? null })
        .returning();
    log.info('projects', 'Project created', { projectId: project.id, userId: user.id });
    return c.json({ project }, 201);
});
// DELETE /api/projects/:id — delete a project (contracts become projectless)
projectsRouter.delete('/:id', requireAuth, async (c) => {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.userId, user.id)),
    });
    if (!project)
        return c.json({ error: 'Not found' }, 404);
    await db.delete(projects).where(eq(projects.id, projectId));
    return c.json({ ok: true });
});
export default projectsRouter;
