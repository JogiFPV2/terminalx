// Notatki: foldery i notatki w pasku bocznym.
// Na dysku: każdy folder to katalog w `notes/`, każda notatka to osobny plik .md.
// Tytuł jest opcjonalny i siedzi w nagłówku front matter; bez tytułu etykietą jest pierwsza linia treści.
// Ręczna kolejność elementów folderu jest w `.order.json` w tym folderze.

const ROOT = 'notes';
const ORDER_FILE = '.order.json';

/** @type {import('../sdk/hermitty-plugin').TxApi} */
let tx;
let root;              // element sekcji w pasku bocznym
let tree = [];         // [{ kind, path, name, title, body, children }]
const open = new Set([ROOT]);
let selectedFolder = ROOT;
let dragPath = null;

export async function activate(api) {
  tx = api;
  await tx.storage.mkdir(ROOT);
  const saved = await tx.storage.readJson('.state.json', { open: [] });
  saved.open.forEach((p) => open.add(p));

  tx.ui.sidebar.registerSection({
    id: 'notes',
    title: 'Notatki',
    icon: 'notebook',
    actions: [
      { id: 'new-note', icon: 'plus', title: 'Nowa notatka', run: () => newNote(targetFolder()) },
      { id: 'new-folder', icon: 'folder-plus', title: 'Nowy folder', run: () => newFolder(targetFolder()) },
    ],
    render(el) {
      root = el;
      injectStyles(el.ownerDocument);
      bindDragAndDrop(el);
      refresh();
    },
  });

  tx.ui.commands.register('notes.new', 'Notatki: nowa notatka', () => newNote(targetFolder()), { keybinding: 'Ctrl+Alt+N' });
  tx.ui.commands.register('notes.newFolder', 'Notatki: nowy folder', () => newFolder(targetFolder()));
  tx.storage.onChange(() => refresh());
}

export function deactivate() {
  root = null;
}

/* ---------- model ---------- */

const ext = () => tx.config.get('fileExtension') || '.md';
const targetFolder = () => (tx.config.get('newNoteInSelectedFolder') ? selectedFolder : ROOT);
const join = (dir, name) => `${dir}/${name}`;
const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

function parseNote(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { title: '', body: text };
  const title = (/^title:\s*(.*)$/m.exec(m[1]) || [])[1] || '';
  return { title: title.trim(), body: text.slice(m[0].length) };
}

function serializeNote({ title, body }) {
  return title ? `---\ntitle: ${title.replace(/\n/g, ' ')}\n---\n${body}` : body;
}

function slug(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function uniquePath(dir, stem, suffix) {
  let path = join(dir, stem + suffix);
  for (let i = 2; await tx.storage.exists(path); i++) path = join(dir, `${stem}-${i}${suffix}`);
  return path;
}

async function readOrder(dir) {
  return tx.storage.readJson(join(dir, ORDER_FILE), []);
}

async function writeOrder(dir, names) {
  await tx.storage.writeJson(join(dir, ORDER_FILE), names);
}

async function readDir(dir) {
  const entries = (await tx.storage.list(dir)).filter((e) => !e.name.startsWith('.'));
  const order = await readOrder(dir);
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  entries.sort((a, b) => rank(a.name) - rank(b.name)
    || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));

  const items = [];
  for (const e of entries) {
    if (e.kind === 'dir') {
      items.push({ kind: 'dir', path: e.path, name: e.name, children: open.has(e.path) ? await readDir(e.path) : null });
    } else if (e.name.endsWith(ext())) {
      const text = await tx.storage.readText(e.path).catch(() => null); // plik mógł zniknąć w trakcie odczytu
      if (text !== null) items.push({ kind: 'note', path: e.path, name: e.name, ...parseNote(text) });
    }
  }
  return items;
}

// Odświeżenia nie mogą się nakładać: kolejne prośby w trakcie odczytu zlewają się w jeden dodatkowy przebieg.
let refreshing = null;
let refreshAgain = false;
function refresh() {
  if (!root) return Promise.resolve();
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do { refreshAgain = false; tree = await readDir(ROOT); } while (refreshAgain);
    if (root) draw();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function saveOpenState() {
  await tx.storage.writeJson('.state.json', { open: [...open].filter((p) => p !== ROOT) });
}

/* ---------- actions ---------- */

async function newNote(dir) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const path = await uniquePath(dir, `notatka-${stamp}`, ext());
  await tx.storage.writeText(path, '');
  open.add(dir);
  await refresh();
  editNote(path, true);
}

async function newFolder(dir) {
  const path = await uniquePath(dir, 'Nowy folder', '');
  await tx.storage.mkdir(path);
  open.add(dir);
  await refresh();
  startRename(path);
}

async function renameFolder(path, name) {
  name = name.trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!name || name === baseName(path)) return refresh();
  const dir = parentOf(path);
  const next = await uniquePath(dir, name, '');
  await tx.storage.move(path, next);
  const order = await readOrder(dir);
  await writeOrder(dir, order.map((n) => (n === baseName(path) ? baseName(next) : n)));
  if (open.delete(path)) open.add(next);
  await saveOpenState();
  await refresh();
}

function editNote(path, isNew) {
  const note = findItem(path);
  tx.ui.dialog.open({
    title: isNew ? 'Nowa notatka' : 'Edytuj notatkę',
    width: 600,
    render(el, dialog) {
      el.innerHTML = `
        <input class="nt-title" placeholder="Tytuł (opcjonalnie)">
        <textarea class="nt-body" placeholder="Treść notatki…"></textarea>
        <div class="nt-foot"><small>${escapeHtml(path)}</small>
          <button class="nt-btn" data-act="cancel">Anuluj</button>
          <button class="nt-btn nt-pri" data-act="save">Zapisz</button></div>`;
      injectStyles(el.ownerDocument);
      const title = el.querySelector('.nt-title');
      const body = el.querySelector('.nt-body');
      title.value = note ? note.title : '';
      body.value = note ? note.body : '';
      (isNew ? body : title).focus();

      const save = async () => {
        const next = { title: title.value.trim(), body: body.value };
        let target = path;
        // Plik bierze nazwę z tytułu; notatki bez tytułu zostają przy nazwie z datą.
        if (next.title && slug(next.title) && !baseName(path).startsWith(slug(next.title))) {
          target = await uniquePath(parentOf(path), slug(next.title), ext());
          await tx.storage.move(path, target);
          await replaceInOrder(parentOf(path), baseName(path), baseName(target));
        }
        await tx.storage.writeText(target, serializeNote(next));
        dialog.close();
        refresh();
      };
      const cancel = async () => {
        dialog.close();
        if (isNew && !title.value.trim() && !body.value.trim()) {
          await tx.storage.remove(path);
          refresh();
        }
      };
      el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'save') save();
        if (act === 'cancel') cancel();
      });
      el.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
        if (e.key === 'Escape') cancel();
      });
    },
  });
}

async function remove(path) {
  const item = findItem(path);
  const label = item.kind === 'dir' ? `Usunięto folder „${item.name}”` : `Usunięto notatkę „${labelOf(item).text.slice(0, 40)}”`;
  await tx.storage.trash(path, { label });
  refresh();
}

async function replaceInOrder(dir, oldName, newName) {
  const order = await readOrder(dir);
  if (order.includes(oldName)) await writeOrder(dir, order.map((n) => (n === oldName ? newName : n)));
}

/**
 * Przenosi element. `pos`: 'into' (do folderu), 'before' / 'after' (obok elementu), 'root'.
 */
async function moveItem(from, targetPath, pos) {
  if (from === targetPath) return;
  const destDir = pos === 'into' ? targetPath : pos === 'root' ? ROOT : parentOf(targetPath);
  if (destDir === from || destDir.startsWith(from + '/')) return; // folder do samego siebie

  let to = join(destDir, baseName(from));
  if (parentOf(from) !== destDir) {
    to = await uniquePath(destDir, baseName(from).replace(/\.[^.]+$/, ''), baseName(from).match(/\.[^.]+$/)?.[0] || '');
    await tx.storage.move(from, to);
    const srcOrder = await readOrder(parentOf(from));
    await writeOrder(parentOf(from), srcOrder.filter((n) => n !== baseName(from)));
  }

  const siblings = (await tx.storage.list(destDir)).filter((e) => !e.name.startsWith('.')).map((e) => e.name);
  const current = (await readOrder(destDir)).filter((n) => siblings.includes(n));
  siblings.forEach((n) => { if (!current.includes(n)) current.push(n); });
  const order = current.filter((n) => n !== baseName(to));
  if (pos === 'before' || pos === 'after') {
    const i = order.indexOf(baseName(targetPath));
    order.splice(pos === 'after' ? i + 1 : i, 0, baseName(to));
  } else {
    order.push(baseName(to));
  }
  await writeOrder(destDir, order);
  if (pos === 'into') open.add(destDir);
  await saveOpenState();
  refresh();
}

/* ---------- rendering ---------- */

const ICON = {
  chev: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

function labelOf(note) {
  if (note.title) return { text: note.title, untitled: false };
  if (!tx.config.get('untitledLabelFromFirstLine')) return { text: 'Bez tytułu', untitled: true };
  const first = note.body.split('\n').find((l) => l.trim());
  return { text: first ? first.trim() : 'Pusta notatka', untitled: true };
}

function findItem(path, items = tree) {
  for (const it of items) {
    if (it.path === path) return it;
    if (it.children) { const f = findItem(path, it.children); if (f) return f; }
  }
  return null;
}

function rows(items, depth) {
  return items.map((it) => {
    const pad = `style="--d:${depth}"`;
    if (it.kind === 'dir') {
      const isOpen = open.has(it.path);
      return `<div class="nr dir ${isOpen ? 'open' : ''} ${selectedFolder === it.path ? 'sel' : ''}" draggable="true" data-path="${escapeHtml(it.path)}" ${pad}>
        <button class="chev" data-act="toggle" aria-label="${isOpen ? 'Zwiń' : 'Rozwiń'}">${svg('chev')}</button>${svg('folder')}
        <span class="nm" data-act="toggle">${escapeHtml(it.name)}</span>
        <span class="acts"><button data-act="new-in" title="Nowa notatka w folderze">${svg('plus')}</button>
        <button data-act="rename" title="Zmień nazwę">${svg('edit')}</button>
        <button class="del" data-act="delete" title="Usuń folder">${svg('trash')}</button></span>
      </div>${isOpen && it.children ? rows(it.children, depth + 1) : ''}`;
    }
    const l = labelOf(it);
    return `<div class="nr note" draggable="true" data-path="${escapeHtml(it.path)}" ${pad}>
      <span class="sp"></span>${svg('file')}<span class="nm ${l.untitled ? 'untitled' : ''}" data-act="edit" title="${escapeHtml(l.text)}">${escapeHtml(l.text)}</span>
      <span class="acts"><button data-act="edit" title="Edytuj">${svg('edit')}</button>
      <button class="del" data-act="delete" title="Usuń">${svg('trash')}</button></span>
    </div>`;
  }).join('');
}

function draw() {
  root.innerHTML = `<div class="notes" data-root>${rows(tree, 0) || '<div class="empty">Brak notatek. Kliknij +, żeby dodać.</div>'}</div>`;
  root.querySelector('[data-root]').addEventListener('click', onClick);
}

async function onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const row = e.target.closest('[data-path]');
  if (!act || !row) return;
  const path = row.dataset.path;
  if (act === 'toggle') {
    open.has(path) ? open.delete(path) : open.add(path);
    selectedFolder = path;
    await saveOpenState();
    refresh();
  }
  if (act === 'new-in') { selectedFolder = path; newNote(path); }
  if (act === 'rename') startRename(path);
  if (act === 'edit') editNote(path, false);
  if (act === 'delete') remove(path);
}

function startRename(path) {
  const row = root.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (!row) return;
  const nm = row.querySelector('.nm');
  const input = row.ownerDocument.createElement('input');
  input.value = baseName(path);
  input.setAttribute('aria-label', 'Nazwa folderu');
  nm.replaceWith(input);
  row.draggable = false;
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => { if (done) return; done = true; commit ? renameFolder(path, input.value) : refresh(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function bindDragAndDrop(el) {
  const clear = () => el.querySelectorAll('.drop-into,.drop-before,.drop-after,.drop-root')
    .forEach((n) => n.classList.remove('drop-into', 'drop-before', 'drop-after', 'drop-root'));

  const target = (e) => {
    const row = e.target.closest('[data-path]');
    if (row) {
      const path = row.dataset.path;
      if (path === dragPath || path.startsWith(dragPath + '/')) return null;
      const box = row.getBoundingClientRect();
      const y = (e.clientY - box.top) / box.height;
      const isDir = row.classList.contains('dir');
      const pos = isDir ? (y < 0.28 ? 'before' : y > 0.72 && !open.has(path) ? 'after' : 'into') : (y < 0.5 ? 'before' : 'after');
      return { el: row, path, pos };
    }
    const r = e.target.closest('[data-root]');
    return r ? { el: r, path: ROOT, pos: 'root' } : null;
  };

  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-path]');
    if (!row) return;
    dragPath = row.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragPath);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  el.addEventListener('dragover', (e) => {
    if (!dragPath) return;
    const t = target(e);
    clear();
    if (!t) return;
    e.preventDefault();
    t.el.classList.add(t.pos === 'root' ? 'drop-root' : `drop-${t.pos}`);
  });
  el.addEventListener('drop', (e) => {
    if (!dragPath) return;
    e.preventDefault();
    const t = target(e);
    clear();
    if (t) moveItem(dragPath, t.path, t.pos);
    dragPath = null;
  });
  el.addEventListener('dragend', () => {
    clear();
    dragPath = null;
    el.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function injectStyles(doc) {
  if (doc.getElementById('tx-notes-css')) return;
  const style = doc.createElement('style');
  style.id = 'tx-notes-css';
  // Kolory pochodzą ze zmiennych motywu, które host wstrzykuje do dokumentu pluginu.
  style.textContent = `
    .notes{display:flex;flex-direction:column;gap:1px;min-height:28px;border-radius:6px;padding-bottom:6px}
    .notes svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
    .nr{display:flex;align-items:center;gap:6px;height:26px;padding:0 3px 0 calc(6px + var(--d) * 14px);border-radius:5px;color:var(--muted-foreground);user-select:none}
    .nr:hover,.nr.sel{background:var(--accent);color:var(--foreground)}
    .nr button{all:unset;cursor:pointer;display:grid;place-items:center;border-radius:4px}
    .nr .chev{width:16px;height:16px;margin-left:-4px}
    .nr .chev svg{width:12px;height:12px;transition:transform .12s}
    .nr.open .chev svg{transform:rotate(90deg)}
    .nr .sp{width:12px}
    .nr .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
    .nr .nm.untitled{font-style:italic;opacity:.85}
    .nr .acts{display:flex;gap:1px;opacity:.45}
    .nr:hover .acts,.nr:focus-within .acts{opacity:1}
    .nr .acts button{width:20px;height:20px}
    .nr .acts button:hover{background:var(--background);color:var(--foreground)}
    .nr .acts .del:hover{color:var(--destructive)}
    .nr .acts svg{width:12px;height:12px}
    .nr input{flex:1;min-width:0;font:inherit;background:var(--background);border:1px solid var(--primary);border-radius:4px;color:inherit;padding:1px 5px;outline:none}
    .nr.dragging{opacity:.35}
    .nr.drop-into{background:color-mix(in oklab,var(--primary) 16%,transparent);box-shadow:inset 0 0 0 1px var(--primary)}
    .nr.drop-before{box-shadow:inset 0 2px 0 var(--primary)}
    .nr.drop-after{box-shadow:inset 0 -2px 0 var(--primary)}
    .notes.drop-root{outline:1px dashed var(--primary);outline-offset:-1px}
    .empty{padding:4px 8px;color:var(--muted-foreground);font-size:12px}
    .nt-title{font:inherit;font-size:16px;font-weight:600;border:0;background:none;color:inherit;padding:4px 0;outline:none;width:100%}
    .nt-body{font-family:var(--font-mono);font-size:12.5px;line-height:1.6;border:0;background:none;color:inherit;min-height:260px;width:100%;resize:vertical;outline:none}
    .nt-foot{display:flex;gap:8px;align-items:center;border-top:1px solid var(--border);padding-top:10px}
    .nt-foot small{margin-right:auto;color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px}
    .nt-btn{font:inherit;font-size:12px;font-weight:500;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:none;color:inherit;cursor:pointer}
    .nt-pri{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}`;
  doc.head.appendChild(style);
}
