import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const STATUSES = ['todo', 'in_progress', 'done'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`;

const SEEDS = [
  {
    name: 'Website Redesign',
    description: 'Refresh the public marketing site.',
    tasks: [
      { title: 'Draft new homepage copy', status: 'in_progress' },
      { title: 'Build component library', status: 'todo' },
      { title: 'Publish changelog post', status: 'done' },
    ],
  },
  {
    name: 'Mobile App',
    description: 'Release the companion mobile application.',
    tasks: [
      { title: 'Set up push notifications', status: 'todo' },
      { title: 'Fix login on iOS 18', status: 'in_progress' },
    ],
  },
];

function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export class TaskBoardStore {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    this.seedIfEmpty();
  }

  seedIfEmpty() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM projects').get();
    if (row.n > 0) return;
    const insertProject = this.db.prepare(
      'INSERT INTO projects (name, description) VALUES (?, ?)'
    );
    const insertTask = this.db.prepare(
      'INSERT INTO tasks (project_id, title, status) VALUES (?, ?, ?)'
    );
    this.db.transaction(() => {
      for (const project of SEEDS) {
        const { lastInsertRowid } = insertProject.run(project.name, project.description);
        for (const task of project.tasks) {
          insertTask.run(lastInsertRowid, task.title, task.status);
        }
      }
    })();
  }

  probe() {
    const row = this.db.prepare('SELECT 1 AS ok').get();
    return row.ok === 1;
  }

  close() {
    this.db.close();
  }

  listProjects() {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at,
                COUNT(t.id) AS task_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id
         ORDER BY p.id ASC`
      )
      .all();
  }

  getProject(id) {
    const pid = asInt(id);
    if (pid === null) return null;
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) ?? null;
  }

  createProject({ name, description }) {
    const result = this.db
      .prepare('INSERT INTO projects (name, description) VALUES (?, ?)')
      .run(name, description ?? '');
    return this.getProject(result.lastInsertRowid);
  }

  updateProject(id, { name, description }) {
    const pid = asInt(id);
    if (pid === null) return null;
    const current = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!current) return null;
    this.db
      .prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?')
      .run(name ?? current.name, description ?? current.description, pid);
    return this.getProject(pid);
  }

  deleteProject(id) {
    const pid = asInt(id);
    if (pid === null) return false;
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    return result.changes > 0;
  }

  projectExists(id) {
    const pid = asInt(id);
    if (pid === null) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid));
  }

  taskRow(id) {
    const tid = asInt(id);
    if (tid === null) return null;
    return this.db
      .prepare(
        `SELECT t.*, p.name AS project_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ?`
      )
      .get(tid) ?? null;
  }

  listTasks({ projectId, status, q }) {
    const clauses = [];
    const params = [];
    const pid = asInt(projectId);
    if (pid !== null) {
      clauses.push('t.project_id = ?');
      params.push(pid);
    }
    if (status && STATUSES.includes(status)) {
      clauses.push('t.status = ?');
      params.push(status);
    }
    if (q) {
      clauses.push('t.title LIKE ?');
      params.push(`%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT t.id, t.project_id, t.title, t.description, t.status,
                t.created_at, t.updated_at, p.name AS project_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         ${where}
         ORDER BY t.id DESC`
      )
      .all(...params);
  }

  listTasksByProject(projectId) {
    return this.listTasks({ projectId });
  }

  createTask({ projectId, title, description, status }) {
    const result = this.db
      .prepare(
        'INSERT INTO tasks (project_id, title, description, status) VALUES (?, ?, ?, ?)'
      )
      .run(projectId, title, description ?? '', status ?? 'todo');
    return this.taskRow(result.lastInsertRowid);
  }

  updateTask(id, { title, description, status, projectId }) {
    const tid = asInt(id);
    if (tid === null) return null;
    const current = this.taskRow(tid);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE tasks
         SET project_id = ?, title = ?, description = ?, status = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        projectId ?? current.project_id,
        title ?? current.title,
        description ?? current.description,
        status ?? current.status,
        tid
      );
    return this.taskRow(tid);
  }

  deleteTask(id) {
    const tid = asInt(id);
    if (tid === null) return false;
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(tid);
    return result.changes > 0;
  }
}