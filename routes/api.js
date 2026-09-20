import { Router } from 'express';
import { STATUSES } from '../lib/db.js';

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function requireBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object.');
  }
}

function cleanText(value, field, { max = 200, allowEmpty = false } = {}) {
  if (value === undefined && allowEmpty) return '';
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_field', `${field} must be a string.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 && !allowEmpty) {
    throw new ApiError(400, 'invalid_field', `${field} must not be empty.`, { field });
  }
  if (trimmed.length > max) {
    throw new ApiError(400, 'invalid_field', `${field} must be at most ${max} characters.`, {
      field,
    });
  }
  return trimmed;
}

function cleanStatus(value) {
  if (value === undefined) return 'todo';
  if (typeof value !== 'string' || !STATUSES.includes(value)) {
    throw new ApiError(400, 'invalid_status', `status must be one of: ${STATUSES.join(', ')}.`);
  }
  return value;
}

function cleanRequiredText(value, field, { max = 200 } = {}) {
  if (value === undefined) {
    throw new ApiError(400, 'invalid_field', `${field} is required.`, { field });
  }
  return cleanText(value, field, { max });
}

function cleanProjectId(value, store) {
  if (value === undefined) {
    throw new ApiError(400, 'invalid_field', 'project_id is required.', { field: 'project_id' });
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, 'invalid_field', 'project_id must be a positive integer.', {
      field: 'project_id',
    });
  }
  if (!store.projectExists(value)) {
    throw new ApiError(404, 'not_found', 'Project not found.', { field: 'project_id' });
  }
  return value;
}

export { ApiError };

export function createApiRouter(store) {
  const router = Router({ mergeParams: true });

  router.get('/projects', (req, res) => {
    res.json({ projects: store.listProjects() });
  });

  router.post('/projects', (req, res) => {
    requireBody(req);
    const name = cleanText(req.body.name, 'name');
    const description = cleanText(req.body.description, 'description', { max: 1000, allowEmpty: true });
    res.status(201).json({ project: store.createProject({ name, description }) });
  });

  router.get('/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) throw new ApiError(404, 'not_found', 'Project not found.');
    res.json({ project: { ...project, tasks: store.listTasksByProject(project.id) } });
  });

  router.patch('/projects/:id', (req, res) => {
    requireBody(req);
    const body = {};
    if (req.body.name !== undefined) body.name = cleanText(req.body.name, 'name');
    if (req.body.description !== undefined) {
      body.description = cleanText(req.body.description, 'description', { max: 1000, allowEmpty: true });
    }
    const project = store.updateProject(req.params.id, body);
    if (!project) throw new ApiError(404, 'not_found', 'Project not found.');
    res.json({ project });
  });

  router.delete('/projects/:id', (req, res) => {
    if (!store.deleteProject(req.params.id)) {
      throw new ApiError(404, 'not_found', 'Project not found.');
    }
    res.status(204).end();
  });

  router.get('/tasks', (req, res) => {
    const { projectId, status, q } = req.query;
    let pid;
    if (projectId !== undefined) {
      pid = Number(projectId);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new ApiError(400, 'invalid_field', 'projectId must be a positive integer.', {
          field: 'projectId',
        });
      }
      if (!store.projectExists(pid)) {
        throw new ApiError(404, 'not_found', 'Project not found.');
      }
    }
    if (status !== undefined && !STATUSES.includes(String(status))) {
      throw new ApiError(400, 'invalid_status', `status must be one of: ${STATUSES.join(', ')}.`);
    }
    const tasks = store.listTasks({
      projectId: pid,
      status: status ? String(status) : undefined,
      q: q ? String(q).trim() : undefined,
    });
    res.json({ tasks });
  });

  router.post('/tasks', (req, res) => {
    requireBody(req);
    const title = cleanRequiredText(req.body.title, 'title');
    const projectId = cleanProjectId(req.body.project_id, store);
    const status = cleanStatus(req.body.status);
    const description = cleanText(req.body.description, 'description', { max: 1000, allowEmpty: true });
    res.status(201).json({ task: store.createTask({ projectId, title, description, status }) });
  });

  router.get('/tasks/:id', (req, res) => {
    const task = store.taskRow(req.params.id);
    if (!task) throw new ApiError(404, 'not_found', 'Task not found.');
    res.json({ task });
  });

  router.patch('/tasks/:id', (req, res) => {
    requireBody(req);
    const body = {};
    if (req.body.title !== undefined) body.title = cleanText(req.body.title, 'title');
    if (req.body.description !== undefined) {
      body.description = cleanText(req.body.description, 'description', { max: 1000, allowEmpty: true });
    }
    if (req.body.status !== undefined) body.status = cleanStatus(req.body.status);
    if (req.body.project_id !== undefined && req.body.project_id !== null) {
      body.projectId = cleanProjectId(req.body.project_id, store);
    }
    const task = store.updateTask(req.params.id, body);
    if (!task) throw new ApiError(404, 'not_found', 'Task not found.');
    res.json({ task });
  });

  router.delete('/tasks/:id', (req, res) => {
    if (!store.deleteTask(req.params.id)) {
      throw new ApiError(404, 'not_found', 'Task not found.');
    }
    res.status(204).end();
  });

  return router;
}