/* ============================================================
 * ISYS 文件库模块（文档 / 压缩包管理）
 *  - 文件夹（目录）树：新建 / 重命名 / 删除（递归）
 *  - 文件：上传（支持各种文件与压缩包 .zip/.rar/.7z）、预览、下载、删除
 *  - 备注列附件：在表格 note / remark 列挂接文档，点击预览 / 下载
 *  - 权限：上传 / 下载仅在「编辑模式」启用；预览（在线查看）始终可用
 *  - 持久化：文件数据写入 data.js 的 ISYS_FILES（随云端同步保存），
 *            同时在浏览器 IndexedDB 做本地镜像，离线也可用、刷新不丢
 * 依赖：data.js（ISYS_FILES）→ app.js（window.ISYS）→ editor.js（window.ISYS_Edit）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 状态 ---------------- */
  function ensureState() {
    if (typeof ISYS_FILES === 'undefined' || !ISYS_FILES ||
        typeof ISYS_FILES.store === 'undefined') {
      window.ISYS_FILES = { store: {}, folders: [], rowAttach: {} };
    }
    const s = window.ISYS_FILES;
    if (!s.store) s.store = {};
    if (!s.folders) s.folders = [];
    if (!s.rowAttach) s.rowAttach = {};
    return s;
  }
  function S() { return ensureState(); }

  function editMode() {
    return !!(window.ISYS && window.ISYS.editMode && window.ISYS.editMode());
  }
  function rerenderTable() {
    if (window.ISYS && typeof window.ISYS.rerender === 'function') {
      try { window.ISYS.rerender(); } catch (e) {}
    }
  }

  /* ---------------- 工具 ---------------- */
  function uid() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function humanSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function extOf(name) { return (String(name).split('.').pop() || '').toLowerCase(); }
  function fileIcon(name, type) {
    const ext = extOf(name), t = (type || '').toLowerCase();
    if (t.indexOf('image/') === 0) return '🖼️';
    if (t === 'application/pdf' || ext === 'pdf') return '📕';
    if (ext === 'zip' || ext === 'rar' || ext === '7z' || t.indexOf('zip') >= 0) return '🗜️';
    if (ext === 'doc' || ext === 'docx') return '📘';
    if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return '📗';
    if (ext === 'ppt' || ext === 'pptx') return '📙';
    if (['txt', 'md', 'json', 'js', 'css', 'html', 'csv', 'log', 'py', 'xml', 'yml', 'yaml'].indexOf(ext) >= 0) return '📄';
    if (ext === 'dwg' || ext === 'dxf') return '📐';
    if (t.indexOf('video/') === 0) return '🎞️';
    if (t.indexOf('audio/') === 0) return '🔊';
    return '📦';
  }
  function previewKind(name, type) {
    const ext = extOf(name), t = (type || '').toLowerCase();
    if (t.indexOf('image/') === 0) return 'image';
    if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (['txt', 'md', 'json', 'js', 'css', 'html', 'csv', 'log', 'py', 'xml', 'yml', 'yaml'].indexOf(ext) >= 0) return 'text';
    return null;
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- IndexedDB 本地镜像 ---------------- */
  let _db = null;
  function openDB() {
    return new Promise(function (resolve) {
      if (_db) return resolve(_db);
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open('isys_files', 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function () { resolve(null); };
    });
  }
  function idbPut(id, data) {
    return openDB().then(function (db) {
      if (!db) return;
      return new Promise(function (res) {
        try {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put({ id: id, data: data });
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { res(); };
        } catch (e) { res(); }
      });
    });
  }
  function idbGet(id) {
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          const r = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
          r.onsuccess = function () { res(r.result ? r.result.data : null); };
          r.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
  function idbDel(id) {
    return openDB().then(function (db) {
      if (!db) return;
      try { db.transaction('blobs', 'readwrite').objectStore('blobs').delete(id); } catch (e) {}
    });
  }

  /* ---------------- 文件读写 ---------------- */
  function addFile(meta) {
    S().store[meta.id] = meta;
    idbPut(meta.id, meta.data);
    schedulePersist();
    return meta;
  }
  function getFile(id) { return S().store[id] || null; }
  function deleteFile(id) {
    delete S().store[id];
    idbDel(id);
    Object.keys(S().rowAttach).forEach(function (pid) {
      Object.keys(S().rowAttach[pid]).forEach(function (ri) {
        const arr = S().rowAttach[pid][ri];
        const i = arr ? arr.indexOf(id) : -1;
        if (i >= 0) arr.splice(i, 1);
      });
    });
    schedulePersist();
  }

  /* ---------------- 文件夹 ---------------- */
  function addFolder(name, parentId) {
    const f = { id: uid(), name: name, parentId: parentId || '' };
    S().folders.push(f);
    schedulePersist();
    return f;
  }
  function renameFolder(id, name) {
    const f = S().folders.filter(function (x) { return x.id === id; })[0];
    if (f) { f.name = name; schedulePersist(); }
  }
  function deleteFolder(id) {
    const toDel = {};
    (function collect(fid) {
      toDel[fid] = 1;
      S().folders.forEach(function (f) { if (f.parentId === fid) collect(f.id); });
    })(id);
    S().folders = S().folders.filter(function (f) { return !toDel[f.id]; });
    Object.keys(S().store).forEach(function (fid) {
      const m = S().store[fid];
      if (m.folderId && toDel[m.folderId]) { idbDel(fid); delete S().store[fid]; }
    });
    schedulePersist();
  }

  /* ---------------- 行附件 ---------------- */
  function attachToRow(pageId, rowIdx, fileId) {
    if (!S().rowAttach[pageId]) S().rowAttach[pageId] = {};
    if (!S().rowAttach[pageId][rowIdx]) S().rowAttach[pageId][rowIdx] = [];
    const arr = S().rowAttach[pageId][rowIdx];
    if (arr.indexOf(fileId) < 0) arr.push(fileId);
    schedulePersist();
  }
  function detachFromRow(pageId, rowIdx, fileId) {
    const arr = S().rowAttach[pageId] && S().rowAttach[pageId][rowIdx];
    if (arr) { const i = arr.indexOf(fileId); if (i >= 0) arr.splice(i, 1); }
    schedulePersist();
  }
  function rowFiles(pageId, rowIdx) {
    const arr = (S().rowAttach[pageId] && S().rowAttach[pageId][rowIdx]) || [];
    return arr.map(getFile).filter(Boolean);
  }

  /* ---------------- 持久化（与表格数据同一云端通道） ---------------- */
  let _persistTimer = null;
  function schedulePersist() {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(function () {
      _persistTimer = null;
      if (window.ISYS_Edit && typeof window.ISYS_Edit.persist === 'function') {
        try { window.ISYS_Edit.persist(); } catch (e) {}
      }
    }, 150);
  }
  function exportJs() { return 'var ISYS_FILES = ' + JSON.stringify(S()) + ';'; }

  /* ---------------- 轻量提示 ---------------- */
  function toast(msg) {
    let t = document.getElementById('isysToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'isysToast';
      t.className = 'isys-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ============================================================
   * 文件库视图（挂载到内容区）
   * ============================================================ */
  let curFolder = '';      // '' 表示「全部文件」
  let libSearch = '';

  function childFolders(pid) { return S().folders.filter(function (f) { return (f.parentId || '') === pid; }); }
  function filesOfFolder(fid) {
    return Object.keys(S().store).map(function (id) { return S().store[id]; })
      .filter(function (m) { return (m.folderId || '') === fid; });
  }

  function folderTreeHtml() {
    const ed = editMode();
    function branch(pid, depth) {
      return childFolders(pid).map(function (f) {
        const kids = branch(f.id, depth + 1);
        const active = curFolder === f.id ? ' active' : '';
        const ctrl = ed
          ? '<span class="ft-ctrl">' +
              '<button class="ft-btn" data-act="rename-folder" data-id="' + f.id + '" title="重命名">✎</button>' +
              '<button class="ft-btn" data-act="del-folder" data-id="' + f.id + '" title="删除目录">🗑</button>' +
            '</span>'
          : '';
        return '<div class="ft-node' + active + '" data-folder="' + f.id + '" style="padding-left:' + (10 + depth * 16) + 'px">' +
          '<span class="ft-ico">📁</span>' +
          '<span class="ft-name">' + esc(f.name) + '</span>' +
          '<span class="ft-cnt">' + filesOfFolder(f.id).length + '</span>' + ctrl +
          '</div>' + kids;
      }).join('');
    }
    const rootActive = curFolder === '' ? ' active' : '';
    return '<div class="ft-node ft-root' + rootActive + '" data-folder="">' +
        '<span class="ft-ico">📂</span><span class="ft-name">全部文件</span>' +
        '<span class="ft-cnt">' + Object.keys(S().store).length + '</span></div>' +
      branch('', 0);
  }

  function fileCardsHtml() {
    const ed = editMode();
    let list = curFolder === '' ? Object.keys(S().store).map(function (id) { return S().store[id]; })
                                : filesOfFolder(curFolder);
    if (libSearch) {
      const q = libSearch.toLowerCase();
      list = list.filter(function (m) { return (m.name || '').toLowerCase().indexOf(q) >= 0; });
    }
    if (!list.length) {
      return '<div class="fl-empty">该目录下还没有文件。' +
        (ed ? '点击右上角「⬆ 上传文件」导入文档或压缩包。' : '请解锁编辑模式后上传文件。') + '</div>';
    }
    return list.map(function (m) {
      const kind = previewKind(m.name, m.type);
      const previewBtn = '<button class="fc-btn" data-act="preview" data-id="' + m.id + '" title="预览">👁 预览</button>';
      const dlBtn = ed
        ? '<button class="fc-btn" data-act="download" data-id="' + m.id + '" title="下载">⬇ 下载</button>'
        : '<button class="fc-btn fc-dis" disabled title="需解锁编辑模式才能下载">⬇ 下载</button>';
      const delBtn = ed
        ? '<button class="fc-btn fc-del" data-act="del-file" data-id="' + m.id + '" title="删除">🗑</button>'
        : '';
      return '<div class="fc-card" data-id="' + m.id + '">' +
        '<div class="fc-ico">' + fileIcon(m.name, m.type) + '</div>' +
        '<div class="fc-name" title="' + esc(m.name) + '">' + esc(m.name) + '</div>' +
        '<div class="fc-meta">' + humanSize(m.size) + ' · ' + fmtDate(m.ts) + '</div>' +
        '<div class="fc-actions">' + previewBtn + dlBtn + delBtn + '</div>' +
      '</div>';
    }).join('');
  }

  function toolbarHtml() {
    const ed = editMode();
    const upBtn = ed
      ? '<button class="fl-btn fl-primary" id="flUploadBtn">⬆ 上传文件</button>'
      : '<button class="fl-btn" disabled title="需解锁编辑模式才能上传">⬆ 上传文件</button>';
    const newBtn = ed
      ? '<button class="fl-btn" id="flNewFolderBtn">📁 新建目录</button>'
      : '<button class="fl-btn" disabled title="需解锁编辑模式才能新建目录">📁 新建目录</button>';
    return '<div class="fl-toolbar">' +
      newBtn + upBtn +
      '<div class="fl-search"><span class="search-icon">🔍</span>' +
        '<input type="text" id="flSearch" placeholder="搜索文件名" value="' + esc(libSearch) + '"></div>' +
      (ed ? '' : '<span class="fl-hint">当前为只读模式，上传 / 下载需解锁编辑</span>') +
      '</div>';
  }

  function renderLibrary(host) {
    if (!host) return;
    const cur = curFolder === '' ? '全部文件'
      : (S().folders.filter(function (f) { return f.id === curFolder; })[0] || {}).name || '全部文件';
    host.innerHTML =
      '<div class="file-lib">' +
        '<div class="fl-head"><h2>📁 文件库</h2><p>在资料库里集中管理文档与压缩包；上传 / 下载需解锁编辑模式，预览始终可用。</p></div>' +
        toolbarHtml() +
        '<div class="fl-body">' +
          '<aside class="fl-tree"><div class="fl-tree-head">目录</div>' + folderTreeHtml() + '</aside>' +
          '<section class="fl-files">' +
            '<div class="fl-cur">当前目录：<b>' + esc(cur) + '</b></div>' +
            '<div class="fl-grid">' + fileCardsHtml() + '</div>' +
          '</section>' +
        '</div>' +
      '</div>';

    // 隐藏的批量上传输入
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'flFileInput';
    inp.multiple = true;
    inp.style.display = 'none';
    inp.accept = '*/*';
    host.appendChild(inp);
  }

  /* ---------------- 文件库事件（委托） ---------------- */
  function bindLibrary(host) {
    if (!host || host._flBound) return;
    host._flBound = true;

    host.addEventListener('click', function (e) {
      const t = e.target.closest('[data-act],[data-folder]');
      if (!t) return;
      if (t.dataset.folder !== undefined) {
        curFolder = t.dataset.folder;
        renderLibrary(host);
        return;
      }
      const act = t.dataset.act, id = t.dataset.id;
      if (act === 'preview') openPreview(id);
      else if (act === 'download') downloadFile(id);
      else if (act === 'del-file') {
        if (!editMode()) return toast('请先解锁编辑模式');
        const m = getFile(id);
        if (confirm('确定删除文件「' + (m ? m.name : '') + '」？')) { deleteFile(id); renderLibrary(host); toast('已删除'); }
      }
      else if (act === 'rename-folder') {
        const f = S().folders.filter(function (x) { return x.id === id; })[0];
        const name = prompt('目录名称：', f ? f.name : '');
        if (name && name.trim()) { renameFolder(id, name.trim()); renderLibrary(host); }
      }
      else if (act === 'del-folder') {
        const f = S().folders.filter(function (x) { return x.id === id; })[0];
        if (confirm('删除目录「' + (f ? f.name : '') + '」及其下所有文件？')) { deleteFolder(id); if (curFolder === id) curFolder = ''; renderLibrary(host); toast('已删除目录'); }
      }
    });

    host.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'flFileInput') { handleUpload(e.target); }
    });

    host.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'flSearch') { libSearch = e.target.value; renderLibrary(host); }
    });

    // 工具栏按钮（每次 renderLibrary 重建，用委托更稳）
    host.addEventListener('click', function (e) {
      if (e.target.id === 'flNewFolderBtn') {
        if (!editMode()) return toast('请先解锁编辑模式');
        const name = prompt('新目录名称：', '新建目录');
        if (name && name.trim()) { addFolder(name.trim(), curFolder); renderLibrary(host); }
      } else if (e.target.id === 'flUploadBtn') {
        if (!editMode()) return toast('请先解锁编辑模式');
        const inp = document.getElementById('flFileInput');
        if (inp) inp.click();
      }
    });
  }

  function handleUpload(input) {
    const files = input.files;
    if (!files || !files.length) return;
    let pending = files.length, warned = false;
    Array.prototype.forEach.call(files, function (f) {
      if (!warned && f.size > 15 * 1048576) {
        warned = true;
        toast('提示：单文件超过 15MB，可能影响加载速度');
      }
      const reader = new FileReader();
      reader.onload = function () {
        const meta = {
          id: uid(), name: f.name, type: f.type || '', size: f.size,
          data: String(reader.result), ts: Date.now(), folderId: curFolder
        };
        addFile(meta);
        if (--pending === 0) { const h = document.getElementById('fileLibHost'); if (h) renderLibrary(h); toast('已上传 ' + files.length + ' 个文件'); }
      };
      reader.onerror = function () { if (--pending === 0) toast('部分文件读取失败'); };
      reader.readAsDataURL(f);
    });
    input.value = '';
  }

  /* ---------------- 预览 ---------------- */
  function openPreview(id) {
    const m = getFile(id);
    if (!m) return toast('文件不存在');
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const kind = previewKind(m.name, m.type);
    let body = '';
    if (kind === 'image') {
      body = '<div class="pv-img-wrap"><img src="' + esc(m.data) + '" alt="' + esc(m.name) + '"></div>';
    } else if (kind === 'pdf') {
      body = '<iframe class="pv-frame" src="' + esc(m.data) + '"></iframe>';
    } else if (kind === 'text') {
      body = '<pre class="pv-text" id="pvText">加载中…</pre>';
    } else {
      body = '<div class="pv-other"><div class="pv-ico">' + fileIcon(m.name, m.type) + '</div>' +
             '<p>该类型（' + esc(m.type || extOf(m.name)) + '）暂不支持在线预览。</p>' +
             (editMode() ? '<button class="fl-btn fl-primary" id="pvDl">⬇ 下载查看</button>'
                         : '<p class="pv-tip">解锁编辑模式后可下载。</p>') + '</div>';
    }
    root.innerHTML =
      '<div class="modal-mask" id="pvMask">' +
        '<div class="modal-box pv-box">' +
          '<div class="modal-head"><span class="pv-title">' + esc(m.name) + '</span>' +
            '<span class="pv-sub">' + humanSize(m.size) + '</span>' +
            '<button class="modal-x" id="pvClose">×</button></div>' +
          '<div class="modal-body">' + body + '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('pvClose').onclick = closeModal;
    document.getElementById('pvMask').onclick = function (e) { if (e.target.id === 'pvMask') closeModal(); };
    if (kind === 'text') {
      const b64 = String(m.data).split(',')[1] || '';
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const txt = new TextDecoder('utf-8').decode(bytes);
        const el = document.getElementById('pvText');
        if (el) el.textContent = txt;
      } catch (e) {
        const el = document.getElementById('pvText');
        if (el) el.textContent = '（文本解码失败）';
      }
    }
    if (kind === null && editMode()) {
      const dl = document.getElementById('pvDl');
      if (dl) dl.onclick = function () { downloadFile(id); };
    }
  }

  function downloadFile(id) {
    if (!editMode()) return toast('请先解锁编辑模式才能下载');
    const m = getFile(id);
    if (!m) return toast('文件不存在');
    const a = document.createElement('a');
    a.href = m.data;
    a.download = m.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function closeModal() {
    const root = document.getElementById('modalRoot');
    if (root) root.innerHTML = '';
  }

  /* ============================================================
   * 备注列附件：渲染 chips + 行附件管理弹窗
   * ============================================================ */
  function renderNoteChips(pageId, rowIdx) {
    const files = rowFiles(pageId, rowIdx);
    const ed = editMode();
    if (!files.length && !ed) return '';   // 只读且无附件时不占地方
    const chips = files.map(function (m) {
      const detach = ed ? '<button class="chip-x" data-detach="' + pageId + '|' + rowIdx + '|' + m.id + '" title="移除附件">×</button>' : '';
      return '<span class="note-chip" data-preview="' + m.id + '" title="' + esc(m.name) + '（' + humanSize(m.size) + '）">' +
        '<span class="chip-ico">' + fileIcon(m.name, m.type) + '</span>' +
        '<span class="chip-name">' + esc(m.name) + '</span>' + detach + '</span>';
    }).join('');
    /* 添加按钮：编辑模式下始终显示，方便随时「添加文档附件」 */
    const addBtn = ed ? '<button class="note-attach" data-attach="' + pageId + '|' + rowIdx + '" title="添加文档附件">📎</button>' : '';
    return '<span class="note-attach-zone">' + chips + addBtn + '</span>';
  }

  function openRowAttach(pageId, rowIdx) {
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const files = rowFiles(pageId, rowIdx);
    const ed = editMode();
    const list = files.length
      ? files.map(function (m) {
          const pv = '<button class="fc-btn" data-pv="' + m.id + '">👁 预览</button>';
          const dl = ed ? '<button class="fc-btn" data-dl="' + m.id + '">⬇ 下载</button>'
                        : '<button class="fc-btn fc-dis" disabled>⬇ 下载</button>';
          const rm = ed ? '<button class="fc-btn fc-del" data-rm="' + m.id + '">🗑</button>' : '';
          return '<div class="ra-row"><span class="ra-ico">' + fileIcon(m.name, m.type) + '</span>' +
            '<span class="ra-name">' + esc(m.name) + '</span>' +
            '<span class="ra-size">' + humanSize(m.size) + '</span>' +
            '<span class="ra-acts">' + pv + dl + rm + '</span></div>';
        }).join('')
      : '<div class="fl-empty">暂无附件。' + (ed ? '' : '解锁编辑模式后可添加。') + '</div>';
    const addBtn = ed ? '<button class="fl-btn fl-primary" id="raAdd">📎 添加文档附件</button>' : '';
    root.innerHTML =
      '<div class="modal-mask" id="raMask">' +
        '<div class="modal-box">' +
          '<div class="modal-head"><span>备注附件</span><button class="modal-x" id="raClose">×</button></div>' +
          '<div class="modal-body"><div class="ra-list">' + list + '</div>' + addBtn + '</div>' +
        '</div>' +
      '</div>';
    const close = function () { closeModal(); };
    document.getElementById('raClose').onclick = close;
    document.getElementById('raMask').onclick = function (e) { if (e.target.id === 'raMask') close(); };
    if (ed) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = '*/*'; inp.style.display = 'none';
      inp.id = 'raFileInput';
      document.body.appendChild(inp);
      document.getElementById('raAdd').onclick = function () { inp.click(); };
      inp.onchange = function () {
        const fs = inp.files; if (!fs || !fs.length) return;
        Array.prototype.forEach.call(fs, function (f) {
          const r = new FileReader();
          r.onload = function () {
            const meta = { id: uid(), name: f.name, type: f.type || '', size: f.size, data: String(r.result), ts: Date.now(), folderId: '' };
            addFile(meta);
            attachToRow(pageId, rowIdx, meta.id);
          };
          r.readAsDataURL(f);
        });
        setTimeout(function () { document.body.removeChild(inp); rerenderTable(); openRowAttach(pageId, rowIdx); toast('已添加附件'); }, 300);
      };
    }
    root.querySelectorAll('[data-pv]').forEach(function (b) { b.onclick = function () { openPreview(b.dataset.pv); }; });
    root.querySelectorAll('[data-dl]').forEach(function (b) { b.onclick = function () { downloadFile(b.dataset.dl); }; });
    root.querySelectorAll('[data-rm]').forEach(function (b) {
      b.onclick = function () {
        detachFromRow(pageId, rowIdx, b.dataset.rm);
        rerenderTable();
        openRowAttach(pageId, rowIdx);
      };
    });
  }

  /* ---------------- 全局事件委托（chips / 备注添加按钮） ---------------- */
  function init() {
    // chips 预览
    document.addEventListener('click', function (e) {
      const pv = e.target.closest('[data-preview]');
      if (pv) { openPreview(pv.dataset.preview); return; }
      const at = e.target.closest('[data-attach]');
      if (at) {
        if (!editMode()) { toast('请先解锁编辑模式'); return; }
        const parts = at.dataset.attach.split('|');
        openRowAttach(parts[0], parts[1]);
        return;
      }
      const dt = e.target.closest('[data-detach]');
      if (dt) {
        if (!editMode()) { toast('请先解锁编辑模式'); return; }
        const p = dt.dataset.detach.split('|');
        detachFromRow(p[0], p[1], p[2]);
        rerenderTable();
      }
    });
  }

  /* ---------------- 对外接口 ---------------- */
  window.ISYS_Files = {
    renderLibrary: renderLibrary,
    bindLibrary: bindLibrary,
    renderNoteChips: renderNoteChips,
    openRowAttach: openRowAttach,
    openPreview: openPreview,
    exportJs: exportJs,
    getState: S
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
