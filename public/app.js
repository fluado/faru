// --- State ---
let cards = [];

// --- API ---

async function fetchCards() {
  const res = await fetch('/api/cards');
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

async function openCard(slug) {
  await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
}

// --- Rendering ---

function badgeClass(type) {
  const map = {
    product: 'badge-product',
    prospect: 'badge-prospect',
    legal: 'badge-legal',
    ops: 'badge-ops',
    infra: 'badge-infra',
  };
  return map[type] || 'badge-product';
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.slug = card.slug;

  const assignee = card.assigned
    ? `<span class="card-assignee">${card.assigned}</span>`
    : '';
  const date = `<span class="card-date">${card.created}</span>`;

  el.innerHTML = `
    <div class="card-title">${escapeHtml(card.title)}</div>
    <div class="card-meta">
      <span class="badge ${badgeClass(card.type)}">${card.type}</span>
      ${date}
      ${assignee}
    </div>
  `;

  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.slug);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.card-list').forEach((l) => {
      l.classList.remove('drag-over');
    });
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
    const filtered = cards.filter((c) => c.status === status);
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

// --- File Grouping ---

function groupFiles(files) {
  if (!files || files.length === 0) return [];

  const groups = {
    reports: { label: '📊 Reports', items: [] },
    specs: { label: '📋 Specs & Plans', items: [] },
    other: { label: '📄 Other', items: [] },
  };

  for (const f of files) {
    const lf = f.toLowerCase();
    if (lf.includes('-report') || lf.includes('report')) {
      groups.reports.items.push(f);
    } else if (
      lf.includes('-milestones') ||
      lf.includes('-spec') ||
      lf.includes('-tickets') ||
      lf.includes('-roadmap')
    ) {
      groups.specs.items.push(f);
    } else {
      groups.other.items.push(f);
    }
  }

  return Object.values(groups).filter((g) => g.items.length > 0);
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

  // Meta
  const meta = document.getElementById('detail-meta');
  const assignee = card.assigned
    ? `<span class="badge">${card.assigned}</span>`
    : '';
  meta.innerHTML = `
    ${assignee}
    <span class="card-date">${card.created}</span>
    ${card.edited ? `<span class="card-date">edited ${card.edited}</span>` : ''}
  `;

  // Type selector
  document.getElementById('detail-type').value = card.type;

  // Status selector
  document.getElementById('detail-status').value = card.status;

  // Progress bar
  const progress = document.getElementById('detail-progress');
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

  // Goal (from first blockquote)
  const body = document.getElementById('detail-body');
  if (card.goal) {
    body.textContent = card.goal;
  } else {
    body.innerHTML = '';
  }

  // Files — grouped, clickable
  const files = document.getElementById('detail-files');
  const groups = groupFiles(card.files);
  if (groups.length > 0) {
    files.innerHTML = groups
      .map(
        (g) => `
      <div class="detail-file-group">
        <div class="detail-file-group-title">${g.label} (${g.items.length})</div>
        ${g.items
          .map(
            (f) =>
              `<div class="detail-file" data-file="${escapeHtml(f)}">${escapeHtml(f)}</div>`
          )
          .join('')}
      </div>
    `
      )
      .join('');

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

  // Inline title editing (Flickr-style)
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

  openBtn.addEventListener('click', () => {
    if (currentDetailSlug) openCard(currentDetailSlug);
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
fetchCards();
