// --- State ---
let cards = [];
let currentUser = '';
let isArchiveView = false;


// --- API ---

async function fetchCards() {
  const url = isArchiveView ? '/api/cards?archive=1' : '/api/cards';
  const res = await fetch(url);
  cards = await res.json();
  render();
}

async function updateCard(slug, updates) {
  await fetch(`/api/cards/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  await fetchCards();
}

async function createCard(data) {
  await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  await fetchCards();
}

async function archiveCard(slug) {
  if (!confirm('Archive this card? It will be moved to backlog/archive/.')) return;
  await fetch(`/api/cards/${encodeURIComponent(slug)}/archive`, { method: 'POST' });
  closeDetail();
  await fetchCards();
}

async function openFile(slug, file) {
  await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, file }),
  });
}

async function openLinkedFile(linkedPath) {
  await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedPath }),
  });
}

async function openCard(slug) {
  await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
}

async function submitComment(slug, text) {
  const res = await fetch(`/api/cards/${encodeURIComponent(slug)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.json();
}

// --- Rendering ---



function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.slug = card.slug;

  const assignee = card.assigned
    ? `<span class="card-assignee">${card.assigned}</span>`
    : '';
  const date = `<span class="card-date">${card.created}</span>`;

  const commentBadge = card.commentCount > 0
    ? `<span class="card-comment-count">💬 ${card.commentCount}</span>`
    : '';

  const milestoneBadge = card.milestoneProgress
    ? `<span class="card-milestone-count">● ${card.milestoneProgress.done}/${card.milestoneProgress.total}</span>`
    : '';

  el.innerHTML = `
    <div class="card-title">${escapeHtml(card.title)}</div>
    <div class="card-meta">
      <span class="category ${card.type}">${card.type}</span>
      ${date}
      <span class="card-meta-right">
        ${assignee}
        ${milestoneBadge}
        ${commentBadge}
      </span>
    </div>
  `;

  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.slug);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.card-list').forEach((l) => { l.classList.remove('drag-over'); });
  });

  el.addEventListener('click', () => {
    if (el.classList.contains('dragging')) return;
    openDetail(card);
  });

  return el;
}

function render() {
  const statuses = ['todo', 'wip', 'done'];
  for (const status of statuses) {
    const list = document.getElementById(`list-${status}`);
    const count = document.getElementById(`count-${status}`);
    list.innerHTML = '';
    const filtered = cards
      .filter((c) => c.status === status)
      .sort((a, b) => b.mtime - a.mtime);
    count.textContent = filtered.length;
    for (const card of filtered) {
      list.appendChild(renderCard(card));
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function linkify(str) {
  return escapeHtml(str).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
}


// --- Drag & Drop ---

function setupDropZones() {
  document.querySelectorAll('.card-list').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.classList.add('drag-over');
    });

    list.addEventListener('dragleave', () => {
      list.classList.remove('drag-over');
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag-over');
      const slug = e.dataTransfer.getData('text/plain');
      const newStatus = list.closest('.column').dataset.status;
      if (!slug || !newStatus) return;

      const card = cards.find((c) => c.slug === slug);
      if (card && card.status !== newStatus) {
        updateCard(slug, { status: newStatus });
      }
    });
  });
}

// --- New Card Modal ---

function setupNewCardModal() {
  const overlay = document.getElementById('modal-overlay');
  const close = document.getElementById('modal-close');
  const form = document.getElementById('new-card-form');
  let pendingStatus = 'todo';

  // Per-column "+" buttons
  document.querySelectorAll('.btn-column-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingStatus = btn.dataset.status;
      if (currentUser) {
        form.querySelector('select[name="assigned"]').value = currentUser;
      }
      overlay.classList.add('open');
      form.querySelector('input[name="title"]').focus();
    });
  });

  close.addEventListener('click', () => {
    overlay.classList.remove('open');
    form.reset();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('open');
      form.reset();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.status = pendingStatus;
    await createCard(data);
    overlay.classList.remove('open');
    form.reset();
  });
}

// --- Detail Modal ---

let currentDetailSlug = null;

function openDetail(card) {
  currentDetailSlug = card.slug;
  const overlay = document.getElementById('detail-overlay');
  const titleEl = document.getElementById('detail-title');
  titleEl.textContent = card.title;
  titleEl.dataset.originalTitle = card.title;

  // Sidebar metadata
  document.getElementById('detail-type').value = card.type;
  document.getElementById('detail-status').value = card.status;
  document.getElementById('detail-assigned').value = card.assigned || '';
  document.getElementById('detail-created').textContent = card.created || '—';
  document.getElementById('detail-edited').textContent = card.edited || '—';

  // Description (editable) — stored as literal \n in frontmatter
  const body = document.getElementById('detail-body');
  const displayGoal = (card.goal || '').replace(/\\n/g, '\n');
  body.innerText = displayGoal;
  body.dataset.originalDescription = card.goal || '';

  // Progress bar — milestone-based when available, report-count fallback
  const progress = document.getElementById('detail-progress');
  if (card.milestoneProgress) {
    const mp = card.milestoneProgress;
    const pct = Math.round((mp.done / mp.total) * 100);
    progress.innerHTML = `
      <div class="detail-progress-label">
        <span>${mp.prefix}: ${mp.done}/${mp.total} milestones</span>
        <span>${pct}%</span>
      </div>
      <div class="detail-progress-bar">
        <div class="detail-progress-fill" style="width:${pct}%"></div>
      </div>
    `;
  } else {
    const reportCount = card.files
      ? card.files.filter((f) => f.toLowerCase().includes('report')).length
      : 0;
    if (reportCount > 0) {
      const totalEstimate = Math.max(reportCount, 3);
      const pct = Math.min(100, Math.round((reportCount / totalEstimate) * 100));
      progress.innerHTML = `
        <div class="detail-progress-label">
          <span>${reportCount} report${reportCount === 1 ? '' : 's'} completed</span>
          <span>${pct}%</span>
        </div>
        <div class="detail-progress-bar">
          <div class="detail-progress-fill" style="width:${pct}%"></div>
        </div>
      `;
    } else {
      progress.innerHTML = '';
    }
  }

  // Milestones checklist
  const milestonesEl = document.getElementById('detail-milestones');
  const milestoneInputZone = document.getElementById('detail-milestone-input');
  const addMilestoneToggle = document.getElementById('add-milestone-toggle');
  const prefixInput = document.getElementById('milestone-prefix-input');

  if (card.milestones && card.milestones.length > 0) {
    milestonesEl.innerHTML = card.milestones.map(m => `
      <div class="detail-milestone-item ${m.done ? 'done' : ''}">
        <span class="milestone-dot ${m.done ? 'milestone-done' : 'milestone-pending'}"></span>
        <span class="milestone-id">${escapeHtml(m.id)}</span>
        <span class="milestone-title">${escapeHtml(m.title)}</span>
      </div>
    `).join('');
    prefixInput.style.display = 'none';
  } else {
    milestonesEl.innerHTML = '';
    prefixInput.style.display = '';
  }

  // Reset milestone input
  document.getElementById('milestone-title-input').value = '';
  milestoneInputZone.style.display = 'none';
  addMilestoneToggle.style.display = '';

  // Files — flat list, clickable
  const files = document.getElementById('detail-files');
  if (card.files && card.files.length > 0) {
    files.innerHTML = `
      <div class="detail-file-group">
        <div class="detail-file-group-title">📎 Files (${card.files.length})</div>
        ${card.files
          .map(
            (f) =>
              `<div class="detail-file" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`
          )
          .join('')}
      </div>
    `;

    // Attach click handlers to files
    files.querySelectorAll('.detail-file').forEach((el) => {
      el.addEventListener('click', () => {
        const fileName = el.dataset.file;
        if (currentDetailSlug && fileName) {
          openFile(currentDetailSlug, fileName);
        }
      });
    });
  } else {
    files.innerHTML = '';
  }

  // Linked files
  const linkedZone = document.getElementById('detail-linked');
  if (card.linkedFiles && card.linkedFiles.length > 0) {
    let html = '';
    for (const link of card.linkedFiles) {
      if (link.isDir) {
        html += `
          <div class="detail-file-group">
            <div class="detail-file-group-title" data-linked-dir="${escapeHtml(link.path)}">🔗 ${escapeHtml(link.name)}/</div>
            ${link.children.map((f) =>
              `<div class="detail-file detail-linked-file" data-linked-path="${escapeHtml(link.path + '/' + f)}">${escapeHtml(f)}</div>`
            ).join('')}
          </div>
        `;
      } else {
        html += `<div class="detail-file detail-linked-file" data-linked-path="${escapeHtml(link.path)}">${escapeHtml(link.name)}</div>`;
      }
    }
    linkedZone.innerHTML = html;

    linkedZone.querySelectorAll('.detail-linked-file').forEach((el) => {
      el.addEventListener('click', () => {
        const lp = el.dataset.linkedPath;
        if (lp) openLinkedFile(lp);
      });
    });

    linkedZone.querySelectorAll('.detail-file-group-title[data-linked-dir]').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        openLinkedFile(el.dataset.linkedDir);
      });
    });
  } else {
    linkedZone.innerHTML = '';
  }

  // Comments
  const commentsEl = document.getElementById('detail-comments');
  const commentInputZone = document.getElementById('detail-comment-input');
  const addCommentToggle = document.getElementById('add-comment-toggle');

  if (card.comments && card.comments.length > 0) {
    commentsEl.innerHTML = card.comments.map(c => `
      <div class="comment">
        <span class="comment-author">${escapeHtml(c.author)}</span>
        <span class="comment-date">· ${escapeHtml(c.date)}</span>
        <div class="comment-text">${linkify(c.text)}</div>
      </div>
    `).join('');
    // Show input when comments exist
    commentInputZone.style.display = 'flex';
    addCommentToggle.style.display = 'none';
  } else {
    commentsEl.innerHTML = '';
    // Collapse: hide input, show toggle
    commentInputZone.style.display = 'none';
    addCommentToggle.style.display = '';
  }

  // Reset comment input
  const commentInput = document.getElementById('comment-input');
  const commentSubmit = document.getElementById('comment-submit');
  commentInput.value = '';
  commentSubmit.disabled = true;

  overlay.classList.add('open');
}

function closeDetail() {
  currentDetailSlug = null;
  document.getElementById('detail-overlay').classList.remove('open');
}

function setupDetailModal() {
  const overlay = document.getElementById('detail-overlay');
  const close = document.getElementById('detail-close');
  const archiveBtn = document.getElementById('detail-archive');
  const statusSelect = document.getElementById('detail-status');
  const typeSelect = document.getElementById('detail-type');
  const titleEl = document.getElementById('detail-title');
  const openBtn = document.getElementById('detail-open');

  close.addEventListener('click', closeDetail);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDetail();
  });

  // Inline title editing (blur-save)
  titleEl.addEventListener('blur', () => {
    const newTitle = titleEl.textContent.trim();
    const original = titleEl.dataset.originalTitle;
    if (currentDetailSlug && newTitle && newTitle !== original) {
      titleEl.dataset.originalTitle = newTitle;
      updateCard(currentDetailSlug, { title: newTitle });
    }
  });

  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    }
    if (e.key === 'Escape') {
      titleEl.textContent = titleEl.dataset.originalTitle;
      titleEl.blur();
    }
  });

  // Inline description editing (blur-save)
  const bodyEl = document.getElementById('detail-body');
  bodyEl.addEventListener('blur', () => {
    const raw = bodyEl.innerText.trim();
    const encoded = raw.replace(/\n/g, '\\n');
    const original = bodyEl.dataset.originalDescription;
    if (currentDetailSlug && encoded !== original) {
      bodyEl.dataset.originalDescription = encoded;
      updateCard(currentDetailSlug, { description: encoded });
    }
  });

  bodyEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      bodyEl.innerText = (bodyEl.dataset.originalDescription || '').replace(/\\n/g, '\n');
      bodyEl.blur();
    }
  });

  archiveBtn.addEventListener('click', () => {
    if (currentDetailSlug) archiveCard(currentDetailSlug);
  });

  typeSelect.addEventListener('change', () => {
    if (currentDetailSlug) {
      updateCard(currentDetailSlug, { type: typeSelect.value });
    }
  });

  statusSelect.addEventListener('change', () => {
    if (currentDetailSlug) {
      updateCard(currentDetailSlug, { status: statusSelect.value });
    }
  });

  const assignedSelect = document.getElementById('detail-assigned');
  assignedSelect.addEventListener('change', () => {
    if (currentDetailSlug) {
      updateCard(currentDetailSlug, { assigned: assignedSelect.value });
    }
  });

  openBtn.addEventListener('click', () => {
    if (currentDetailSlug) openCard(currentDetailSlug);
  });

  // Comment input — enable/disable submit
  const commentInput = document.getElementById('comment-input');
  const commentSubmit = document.getElementById('comment-submit');

  commentInput.addEventListener('input', () => {
    commentSubmit.disabled = !commentInput.value.trim();
  });

  // Enter to submit, Shift+Enter for newline
  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (commentInput.value.trim()) commentSubmit.click();
    }
  });

  commentSubmit.addEventListener('click', async () => {
    const text = commentInput.value.trim();
    if (!text || !currentDetailSlug) return;

    // Optimistic render
    const commentsEl = document.getElementById('detail-comments');
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
    commentsEl.innerHTML += `
      <div class="comment">
        <span class="comment-author">${escapeHtml(currentUser || 'you')}</span>
        <span class="comment-date">· ${dateStr}</span>
        <div class="comment-text">${linkify(text)}</div>
      </div>
    `;
    commentsEl.scrollTop = commentsEl.scrollHeight;

    commentInput.value = '';
    commentSubmit.disabled = true;
    commentInput.focus();

    await submitComment(currentDetailSlug, text);
    await fetchCards();
  });

  // Toggle "+ Add comment" → reveal input
  document.getElementById('add-comment-toggle').addEventListener('click', () => {
    document.getElementById('detail-comment-input').style.display = 'flex';
    document.getElementById('add-comment-toggle').style.display = 'none';
    document.getElementById('comment-input').focus();
  });

  // Milestone input — toggle, submit, enter-key
  document.getElementById('add-milestone-toggle').addEventListener('click', () => {
    document.getElementById('detail-milestone-input').style.display = 'flex';
    document.getElementById('add-milestone-toggle').style.display = 'none';
    document.getElementById('milestone-title-input').focus();
  });

  const milestoneSubmit = document.getElementById('milestone-submit');
  const milestoneTitleInput = document.getElementById('milestone-title-input');
  const milestonePrefixInput = document.getElementById('milestone-prefix-input');

  milestoneTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (milestoneTitleInput.value.trim()) milestoneSubmit.click();
    }
  });

  milestoneSubmit.addEventListener('click', async () => {
    const title = milestoneTitleInput.value.trim();
    if (!title || !currentDetailSlug) return;

    const payload = { title };
    const prefix = milestonePrefixInput.value.trim();
    if (prefix) payload.prefix = prefix;

    try {
      await fetch(`/api/cards/${encodeURIComponent(currentDetailSlug)}/milestones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      milestoneTitleInput.value = '';
      milestonePrefixInput.value = '';
      await fetchCards();
      // Re-open the detail with refreshed data
      const updated = cards.find(c => c.slug === currentDetailSlug);
      if (updated) openDetail(updated);
    } catch (e) {
      console.error('Failed to add milestone:', e);
    }
  });
}

// --- Keyboard ---

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('modal-overlay').classList.remove('open');
    document.getElementById('detail-overlay').classList.remove('open');
    currentDetailSlug = null;
  }
});

// --- Init ---

setupDropZones();
setupNewCardModal();
setupDetailModal();

document.getElementById('btn-toggle-archive')?.addEventListener('click', (e) => {
  isArchiveView = !isArchiveView;
  if (isArchiveView) {
    document.body.classList.add('archive-mode');
    e.target.textContent = 'Exit Archive';
  } else {
    document.body.classList.remove('archive-mode');
    e.target.textContent = 'Archive';
  }
  fetchCards();
});

fetchCards();

// Fetch current git user for auto-assign
fetch('/api/whoami').then(r => r.json()).then(d => { currentUser = d.user || ''; }).catch(() => {});

// Fetch config and populate type selects + check agent dispatch
fetch('/api/config')
  .then(r => r.json())
  .then(cfg => {
    const selects = [document.getElementById('new-card-type'), document.getElementById('detail-type')];
    for (const sel of selects) {
      sel.innerHTML = '';
      for (const cat of cfg.cardCategories) {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
        sel.appendChild(opt);
      }
    }
    // Agent dispatch
    agentEnabled = cfg.agentEnabled || false;
    if (agentEnabled) {
      fetch('/api/dispatch/skills')
        .then(r => r.json())
        .then(skills => { allSkills = skills; })
        .catch(() => {});
      startDispatchPolling();
    }
  })
  .catch(() => {});

// Fetch assignees and populate assignee selects
fetch('/api/assignees')
  .then(r => r.json())
  .then(assignees => {
    const selects = [document.getElementById('new-card-assigned'), document.getElementById('detail-assigned')];
    for (const sel of selects) {
      // Keep the static "Unassigned" option, append live values
      for (const name of assignees) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        sel.appendChild(opt);
      }
    }
  })
  .catch(() => {});

// --- Weekly Goal ---
const goalEl = document.getElementById('goal-text');
let goalSaveTimer = null;

fetch('/api/goal')
  .then(r => r.json())
  .then(data => {
    if (data.text) goalEl.textContent = data.text;
  })
  .catch(() => {});

function saveGoal() {
  const text = goalEl.textContent.trim();
  fetch('/api/goal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

goalEl.addEventListener('blur', () => {
  clearTimeout(goalSaveTimer);
  saveGoal();
});

goalEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    goalEl.blur();
  }
});

// --- Agent Dispatch ---

let agentEnabled = false;
let allSkills = [];
let dispatchChain = [];
let dispatchSlug = null;
let dispatchPollTimer = null;

function startDispatchPolling() {
  if (dispatchPollTimer) return;
  dispatchPollTimer = setInterval(pollDispatchStatus, 3000);
  pollDispatchStatus();
}

let lastDispatchStatus = 'idle';

async function pollDispatchStatus() {
  if (!agentEnabled) return;
  try {
    const res = await fetch('/api/dispatch/status');
    const s = await res.json();
    lastDispatchStatus = s.status;
    updateDispatchUI(s);
  } catch (_) {}
}

function updateDispatchUI(s) {
  const btn = document.getElementById('detail-dispatch');
  if (!btn) return;

  if (s.status === 'running') {
    const skillName = s.currentSkill ? s.currentSkill.replace(/-/g, ' ') : '...';
    btn.textContent = `⏳ ${skillName} (${s.chainIndex + 1}/${s.chainLength})`;
    btn.classList.add('dispatch-running');
    btn.disabled = false;
    btn.onclick = abortDispatch;
  } else {
    btn.textContent = '🤖 Dispatch to Agent';
    btn.classList.remove('dispatch-running');
    btn.disabled = false;
    btn.onclick = null; // handled by setupDispatchModal
  }
}

async function abortDispatch() {
  if (!confirm('Abort the current dispatch?')) return;
  try {
    await fetch('/api/dispatch/abort', { method: 'POST' });
    await fetchCards();
    pollDispatchStatus();
  } catch (_) {}
}

// Render dispatch chain in the modal
let dragFromIndex = null;

function renderDispatchChain() {
  const container = document.getElementById('dispatch-chain');
  container.innerHTML = '';

  dispatchChain.forEach((step, i) => {
    const skill = allSkills.find(s => s.id === step.skill);
    const name = skill ? skill.name : step.skill;

    const el = document.createElement('div');
    el.className = 'dispatch-skill-item';
    el.dataset.index = i;

    el.innerHTML = `
      <div class="dispatch-skill-header">
        <span class="dispatch-skill-handle" draggable="true">≡</span>
        <span class="dispatch-skill-index">${i + 1}.</span>
        <span class="dispatch-skill-name">${escapeHtml(name)}</span>
        <button class="dispatch-skill-remove" data-index="${i}">✕</button>
      </div>
      <textarea class="dispatch-skill-context" placeholder="Optional instructions for this skill…" rows="1" data-index="${i}">${escapeHtml(step.context || '')}</textarea>
    `;

    // Remove button
    el.querySelector('.dispatch-skill-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      dispatchChain.splice(i, 1);
      renderDispatchChain();
    });

    // Context textarea sync
    el.querySelector('.dispatch-skill-context').addEventListener('input', (e) => {
      dispatchChain[i].context = e.target.value;
    });

    // Drag starts from the handle only
    const handle = el.querySelector('.dispatch-skill-handle');
    handle.addEventListener('dragstart', (e) => {
      dragFromIndex = i;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });

    handle.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragFromIndex = null;
      container.querySelectorAll('.dispatch-skill-item').forEach(item => {
        item.classList.remove('drag-above', 'drag-below');
      });
    });

    container.appendChild(el);
  });

  // Container-level drop zone
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const items = [...container.querySelectorAll('.dispatch-skill-item:not(.dragging)')];
    items.forEach(item => item.classList.remove('drag-above', 'drag-below'));
    const target = items.find(item => {
      const rect = item.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    if (target) {
      target.classList.add('drag-above');
    } else if (items.length > 0) {
      items[items.length - 1].classList.add('drag-below');
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragFromIndex === null) return;
    const items = [...container.querySelectorAll('.dispatch-skill-item:not(.dragging)')];
    items.forEach(item => item.classList.remove('drag-above', 'drag-below'));

    // Find insertion index
    let toIdx = dispatchChain.length - 1;
    for (let j = 0; j < items.length; j++) {
      const rect = items[j].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        toIdx = parseInt(items[j].dataset.index, 10);
        break;
      }
    }

    if (dragFromIndex === toIdx) return;
    const [moved] = dispatchChain.splice(dragFromIndex, 1);
    if (toIdx > dragFromIndex) toIdx--;
    dispatchChain.splice(toIdx, 0, moved);
    dragFromIndex = null;
    renderDispatchChain();
  });

  // Update start button
  const startBtn = document.getElementById('dispatch-start');
  startBtn.disabled = dispatchChain.length === 0;

  // Update "add skill" dropdown — filter out skills already in chain
  const select = document.getElementById('dispatch-skill-select');
  const usedIds = new Set(dispatchChain.map(s => s.skill));
  select.innerHTML = '<option value="">+ Add skill</option>';
  for (const s of allSkills) {
    if (!usedIds.has(s.id)) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    }
  }
}

function setupDispatchModal() {
  const overlay = document.getElementById('dispatch-overlay');
  const closeBtn = document.getElementById('dispatch-close');
  const cancelBtn = document.getElementById('dispatch-cancel');
  const startBtn = document.getElementById('dispatch-start');
  const skillSelect = document.getElementById('dispatch-skill-select');
  const dispatchBtn = document.getElementById('detail-dispatch');

  if (!overlay) return;

  function closeDispatch() {
    overlay.classList.remove('open');
  }

  closeBtn.addEventListener('click', closeDispatch);
  cancelBtn.addEventListener('click', closeDispatch);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDispatch();
  });

  // Add skill from dropdown
  skillSelect.addEventListener('change', () => {
    const id = skillSelect.value;
    if (!id) return;
    dispatchChain.push({ skill: id, context: '' });
    skillSelect.value = '';
    renderDispatchChain();
  });

  // Start dispatch
  startBtn.addEventListener('click', async () => {
    if (dispatchChain.length === 0 || !dispatchSlug) return;

    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';

    try {
      await fetch(`/api/cards/${encodeURIComponent(dispatchSlug)}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain: dispatchChain }),
      });
      closeDispatch();
      await fetchCards();
      pollDispatchStatus();
    } catch (e) {
      startBtn.textContent = '▶ Start dispatch';
      startBtn.disabled = false;
      alert('Failed to start dispatch: ' + e.message);
    }
  });

  // Dispatch button in card detail — opens the dispatch modal
  dispatchBtn.addEventListener('click', async () => {
    if (lastDispatchStatus === 'running') {
      abortDispatch();
      return;
    }

    if (!currentDetailSlug) return;
    dispatchSlug = currentDetailSlug;

    const card = cards.find(c => c.slug === dispatchSlug);
    if (!card) return;

    // Set title and context
    document.getElementById('dispatch-title').textContent = `🤖 Dispatch: ${card.title}`;
    const contextText = document.getElementById('dispatch-context-text');
    contextText.textContent = card.goal || 'No description set.';

    // Get suggested chain from server
    try {
      const res = await fetch('/api/dispatch/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: card.type, files: card.files || [] }),
      });
      dispatchChain = await res.json();
    } catch (_) {
      dispatchChain = [];
    }

    renderDispatchChain();

    startBtn.textContent = '▶ Start dispatch';
    startBtn.disabled = dispatchChain.length === 0;

    document.getElementById('dispatch-overlay').classList.add('open');

    // Check agent availability
    const avail = document.getElementById('dispatch-availability');
    const availText = document.getElementById('dispatch-availability-text');
    avail.className = 'dispatch-availability checking';
    availText.textContent = 'Checking agent…';
    startBtn.disabled = true;

    try {
      const availRes = await fetch('/api/dispatch/available');
      const availData = await availRes.json();
      if (availData.available) {
        avail.className = 'dispatch-availability available';
        availText.textContent = 'Agent is idle and ready';
        startBtn.disabled = dispatchChain.length === 0;
      } else {
        avail.className = 'dispatch-availability unavailable';
        availText.textContent = availData.reason
          ? `Agent unavailable: ${availData.reason}`
          : 'Agent is not available — is the IDE running with CDP enabled?';
        startBtn.disabled = true;
      }
    } catch (_) {
      avail.className = 'dispatch-availability unavailable';
      availText.textContent = 'Could not reach agent';
      startBtn.disabled = true;
    }
  });
}

// Show/hide dispatch button based on agent config
function updateDispatchButton(card) {
  const btn = document.getElementById('detail-dispatch');
  if (!btn) return;
  if (agentEnabled && card.status !== 'done') {
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

// Patch openDetail to call updateDispatchButton
const _originalOpenDetail = openDetail;
openDetail = function(card) {
  _originalOpenDetail(card);
  updateDispatchButton(card);
};

// Escape key closes dispatch modal too
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('dispatch-overlay')?.classList.remove('open');
  }
});

setupDispatchModal();
