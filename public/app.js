const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  projects: [],
  tasks: [],
  search: '',
  status: '',
};

let activeProjectId = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, isError = false) {
  const node = el('div', `toast${isError ? ' error' : ''}`, message);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

async function reload() {
  const [projectData, taskData] = await Promise.all([
    api('/api/projects'),
    api('/api/tasks'),
  ]);
  state.projects = projectData.projects;
  state.tasks = taskData.tasks;
  render();
}

function filteredTasks() {
  const q = state.search.toLowerCase();
  return state.tasks.filter((t) => {
    if (state.status && t.status !== state.status) return false;
    if (q && !t.title.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

function taskById(id) {
  return state.tasks.find((t) => t.id === id);
}

function render() {
  const board = document.getElementById('board');
  board.textContent = '';
  const visible = filteredTasks();

  for (const project of state.projects) {
    const tasks = visible.filter((t) => t.project_id === project.id);
    const card = renderProject(project, tasks);
    board.appendChild(card);
    if (activeProjectId === project.id) {
      card.scrollIntoView({ block: 'nearest' });
      activeProjectId = null;
    }
  }

  document.getElementById('empty').classList.toggle('hidden', state.projects.length > 0);
}

function renderProject(project, tasks) {
  const card = el('article', 'project-card card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, project.name));
  head.appendChild(el('span', 'count', `${project.task_count} task${project.task_count === 1 ? '' : 's'}`));
  card.appendChild(head);

  if (project.description) {
    card.appendChild(el('p', 'desc', project.description));
  }

  const form = el('form', 'new-task-row');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ project_id: project.id, title }),
      });
      input.value = '';
      await reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
  const input = el('input');
  input.placeholder = 'Add a task…';
  input.maxLength = 200;
  form.appendChild(input);
  const addBtn = el('button', 'btn', '+');
  addBtn.type = 'submit';
  addBtn.title = 'Add task';
  form.appendChild(addBtn);

  const list = el('ul', 'task-list');
  if (tasks.length === 0) {
    list.appendChild(el('li', 'empty', 'No tasks match this view.'));
  } else {
    for (const t of tasks) list.appendChild(renderTask(t));
  }

  card.appendChild(list);
  card.appendChild(form);
  return card;
}

function renderTask(task) {
  const item = el('li', `task-item status-${task.status}`);

  const top = el('div', 'task-top');
  top.appendChild(el('span', 'status-dot'));
  top.appendChild(el('span', 'task-title', task.title));

  const statusSelect = el('select', 'select-status');
  ['todo', 'in_progress', 'done'].forEach((s) => {
    const option = el('option', null, s.replace('_', ' '));
    option.value = s;
    if (s === task.status) option.selected = true;
    statusSelect.appendChild(option);
  });
  statusSelect.addEventListener('change', async () => {
    try {
      const { task: updated } = await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: statusSelect.value }),
      });
      task.status = updated.status;
      item.className = `task-item status-${updated.status}`;
    } catch (err) {
      statusSelect.value = task.status;
      toast(err.message, true);
    }
  });
  top.appendChild(statusSelect);
  item.appendChild(top);

  if (task.description) item.appendChild(el('p', 'task-desc', task.description));

  const actions = el('div', 'task-actions');
  const editBtn = el('button', 'btn', 'Edit');
  editBtn.addEventListener('click', () => startEdit(item, task));
  const deleteBtn = el('button', 'btn danger', 'Delete');
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  item.appendChild(actions);

  return item;
}

function startEdit(item, task) {
  item.textContent = '';
  const form = el('form', 'edit-task');
  const titleInput = el('input');
  titleInput.value = task.title;
  titleInput.maxLength = 200;
  const descInput = el('input');
  descInput.value = task.description || '';
  descInput.placeholder = 'Description (optional)';
  const save = el('button', 'btn primary', 'Save');
  const cancel = el('button', 'btn', 'Cancel');
  form.append(titleInput, descInput);
  const row = el('div', 'row');
  row.append(save, cancel);
  form.appendChild(row);

  cancel.addEventListener('click', () => item.replaceWith(renderTask(task)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { task: updated } = await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: titleInput.value.trim(),
          description: descInput.value.trim(),
        }),
      });
      toast('Task updated');
      Object.assign(task, updated);
      item.replaceWith(renderTask(updated));
    } catch (err) {
      toast(err.message, true);
    }
  });

  item.appendChild(form);
  titleInput.focus();
}

async function init() {
  const info = await api('/api/info');
  const marker = `build ${info.build} · v${info.version}`;
  document.getElementById('build-marker').textContent = marker;
  document.getElementById('footer-marker').textContent = `deploy-test-dockerfile · ${info.build}`;

  document.getElementById('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });
  document.getElementById('status-filter').addEventListener('change', (e) => {
    state.status = e.target.value;
    render();
  });

  const newProjectForm = document.getElementById('new-project-form');
  document.getElementById('new-project-btn').addEventListener('click', () => {
    newProjectForm.classList.toggle('hidden');
  });
  document.getElementById('cancel-project').addEventListener('click', () => {
    newProjectForm.classList.add('hidden');
  });
  newProjectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { project } = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('project-name').value.trim(),
          description: document.getElementById('project-description').value.trim(),
        }),
      });
      toast('Project created');
      newProjectForm.classList.add('hidden');
      document.getElementById('project-name').value = '';
      document.getElementById('project-description').value = '';
      activeProjectId = project.id;
      await reload();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (hash.startsWith('project=')) {
    state.status = '';
  }

  await reload();
}

init().catch((err) => toast(err.message, true));