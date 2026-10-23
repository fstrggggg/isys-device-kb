/* ============================================================
 * ISYS 开发平台 —— 自由多级文件树模块（项目管理 / 知识库 / 工具 / 标准化管理）
 *
 * 能力：
 *   - 任意层级目录（新建 / 重命名 / 删除）
 *   - 导入文件（图片 / PDF / 文本 / 音视频 / Office / 压缩包）
 *   - 网页内直接预览（图片 / PDF / 文本 / 音视频；Office / 压缩包提供下载）
 *   - 数据持久化：
 *       · 目录结构 + 文件元信息 存仓库根 filetree.json（复用 GitHub PAT 同步）
 *       · 文件本体 存仓库 /files/<分类>/<路径>/<文件名>
 *       · 已连接 GitHub（🔑 连接）时导入即上传并持久化；未连接时仅本次会话预览。
 *
 * 与 app.js 对接：app.js 在切到文件型一级目录时调用 ISYS_FileTree.render(host, catId)
 * ============================================================ */
(function () {
  'use strict';

  var CONFIG = { owner: 'fstrggggg', repo: 'isys-device-kb', branch: 'main' };
  var LS_TOKEN = 'isys_github_token';
  var PAGES_BASE = 'https://' + CONFIG.owner + '.github.io/' + CONFIG.repo + '/';
  var RAW_BASE = 'https://raw.githubusercontent.com/' + CONFIG.owner + '/' + CONFIG.repo + '/' + CONFIG.branch + '/';
  var API_BASE = 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/';

  /* ---------------- 状态 ---------------- */
  var trees = clone(window.ISYS_FILE_TREES || { updated: '', trees: {} });
  var curCat = null;        // 当前分类（proj/kb/tools/std）
  var curRel = '';          // 当前文件夹相对路径（''=根）
  var keyword = '';
  var includeSub = false;
  var _host = null;

  /* ---------------- 工具 ---------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function getToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; }
  }
  function connected() { return !!getToken(); }

  function kindOf(name) {
    var ext = (String(name).split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].indexOf(ext) > -1) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (['txt', 'md', 'markdown', 'json', 'csv', 'log', 'ini', 'xml', 'html', 'htm', 'js', 'css', 'ts', 'yml', 'yaml', 'conf', 'text'].indexOf(ext) > -1) return 'text';
    if (['mp4', 'webm', 'ogv', 'mov', 'm4v'].indexOf(ext) > -1) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].indexOf(ext) > -1) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext) > -1) return 'archive';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].indexOf(ext) > -1) return 'office';
    return 'file';
  }
  function kindIcon(k) {
    return ({ image: '🖼️', pdf: '📕', text: '📄', archive: '🗜️', office: '📊', video: '🎬', audio: '🎵', file: '📎' })[k] || '📎';
  }
  function kindName(k) {
    return ({ image: '图片', pdf: 'PDF', text: '文本', archive: '压缩包', office: 'Office', video: '视频', audio: '音频', file: '文件' })[k] || '文件';
  }
  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function nowStr() {
    var d = new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- 树操作 ---------------- */
  function catTree(cat) { return trees.trees[cat]; }
  function root(cat) { var t = catTree(cat); return t ? t.root : null; }

  function findFolder(cat, rel) {
    var node = root(cat);
    if (!rel) return node;
    var parts = String(rel).split('/');
    for (var i = 0; i < parts.length; i++) {
      if (!node || node.type !== 'folder') return null;
      var found = null;
      for (var j = 0; j < node.children.length; j++) {
        var c = node.children[j];
        if (c.type === 'folder' && c.name === parts[i]) { found = c; break; }
      }
      if (!found) return null;
      node = found;
    }
    return node;
  }

  function splitPath(rel) { return rel ? String(rel).split('/') : []; }

  function createFolder(cat, parentRel, name) {
    name = (name || '').trim();
    if (!name) return { ok: false, msg: '目录名不能为空' };
    var parent = findFolder(cat, parentRel);
    if (!parent || parent.type !== 'folder') return { ok: false, msg: '父目录不存在' };
    if (parent.children.some(function (c) { return c.name === name; })) return { ok: false, msg: '同级已存在同名项' };
    parent.children.push({ type: 'folder', name: name, children: [] });
    markDirty(cat);
    return { ok: true };
  }

  function deleteNode(cat, parentRel, name) {
    var parent = findFolder(cat, parentRel);
    if (!parent) return false;
    var idx = -1;
    parent.children.forEach(function (c, i) { if (c.name === name) idx = i; });
    if (idx < 0) return false;
    parent.children.splice(idx, 1);
    markDirty(cat);
    return true;
  }

  function renameNode(cat, parentRel, oldName, newName) {
    newName = (newName || '').trim();
    if (!newName || newName === oldName) return { ok: false, msg: '名称无效' };
    var parent = findFolder(cat, parentRel);
    if (!parent) return { ok: false, msg: '父目录不存在' };
    if (parent.children.some(function (c) { return c.name === newName; })) return { ok: false, msg: '同级已存在同名项' };
    var node = null;
    parent.children.forEach(function (c) { if (c.name === oldName) node = c; });
    if (!node) return { ok: false, msg: '未找到节点' };
    node.name = newName;
    markDirty(cat);
    return { ok: true };
  }

  /* 把文件加入当前文件夹 */
  function addFile(cat, parentRel, fileNode) {
    var parent = findFolder(cat, parentRel);
    if (!parent) return false;
    parent.children.push(fileNode);
    markDirty(cat);
    return true;
  }

  /* ---------------- 持久化（GitHub） ---------------- */
  function cleanTree(node) {
    if (node.type === 'folder') {
      return { type: 'folder', name: node.name, children: (node.children || []).map(cleanTree) };
    }
    var o = { type: 'file', name: node.name, kind: node.kind };
    if (node.url) o.url = node.url;
    if (node.sizeText) o.sizeText = node.sizeText;
    if (node.mtime) o.mtime = node.mtime;
    return o;
  }

  var saveTimer = null;
  function markDirty(cat) {
    trees.updated = nowStr();
    if (catTree(cat)) {
      // 标记分类更新时间（可选）
    }
    if (!connected()) return;          // 未连接则不写云端（仅内存 + 会话内）
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistTree, 800);
  }

  function persistTree() {
    var payload = { updated: trees.updated, trees: {} };
    Object.keys(trees.trees).forEach(function (k) {
      payload.trees[k] = { name: trees.trees[k].name, root: cleanTree(trees.trees[k].root) };
    });
    var b64 = b64EncodeUnicode(JSON.stringify(payload, null, 2));
    ghPut('filetree.json', b64, '更新文件树结构', null);
  }

  function b64EncodeUnicode(str) {
    // UTF-8 安全的 base64
    return btoa(unescape(encodeURIComponent(str)));
  }

  function ghPut(path, contentB64, message, sha) {
    var token = getToken();
    if (!token) return Promise.reject(new Error('未连接 GitHub'));
    var url = API_BASE + path;
    var body = { message: message, content: contentB64 };
    if (sha) body.sha = sha;
    return fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'token ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 200)); });
      return r.json();
    });
  }

  /* 上传文件本体到 /files/<cat>/<rel>/<name> */
  function uploadFile(cat, rel, file) {
    return fileToB64(file).then(function (b64) {
      var path = 'files/' + cat + '/' + (rel ? rel + '/' : '') + file.name;
      return ghPut(path, b64, '上传文件 ' + file.name, null).then(function () {
        return PAGES_BASE + 'files/' + cat + '/' + (rel ? encodePath(rel) + '/' : '') + encodeURIComponent(file.name);
      });
    });
  }
  function encodePath(rel) { return splitPath(rel).map(encodeURIComponent).join('/'); }

  function fileToB64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve((fr.result).split(',')[1]); }; // 去掉 data:...;base64, 前缀
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(file);
    });
  }

  /* 启动时尝试拉取远端 filetree.json 覆盖默认 */
  function bootstrap() {
    return fetch(RAW_BASE + 'filetree.json').then(function (r) {
      if (!r.ok) return null;
      return r.text();
    }).then(function (txt) {
      if (!txt) return;
      try {
        var remote = JSON.parse(txt);
        if (remote && remote.trees) {
          Object.keys(remote.trees).forEach(function (k) {
            if (remote.trees[k] && remote.trees[k].root) trees.trees[k] = remote.trees[k];
          });
          if (remote.updated) trees.updated = remote.updated;
        }
      } catch (e) { /* 解析失败忽略，用默认 */ }
    }).catch(function () { /* 网络/跨域忽略 */ });
  }

  /* ---------------- 渲染 ---------------- */
  function render(host, catId) {
    _host = host;
    curCat = catId;
    if (curRel && !findFolder(catId, curRel)) curRel = '';
    host.classList.add('filetree-host');

    var t = catTree(catId);
    if (!t) {
      host.innerHTML = '<div class="ft-empty">未找到分类「' + esc(catId) + '」。</div>';
      return;
    }

    host.innerHTML =
      '<div class="ft-wrap">' +
        '<aside class="ft-side">' +
          '<div class="ft-side-head">📁 ' + esc(t.name) + '<span class="ft-side-sub">目录结构</span></div>' +
          '<div class="ft-tree">' + sideTreeHtml(catId, t.root, '', 0) + '</div>' +
          '<div class="ft-side-foot">' +
            (connected()
              ? '<span class="ft-conn ok">● 已连接 GitHub</span>'
              : '<span class="ft-conn warn">○ 未连接 GitHub（导入仅本次会话，<a href="#" class="ft-link-connect">去连接</a>后持久化）</span>') +
          '</div>' +
        '</aside>' +
        '<section class="ft-main">' +
          '<div class="ft-toolbar">' +
            '<div class="ft-search"><span>🔍</span>' +
              '<input type="text" id="ftSearch" placeholder="搜索文件名…" value="' + esc(keyword) + '" autocomplete="off">' +
              (keyword ? '<button class="ft-clr" id="ftSearchClr" title="清空">×</button>' : '') +
            '</div>' +
            '<label class="ft-chk"><input type="checkbox" id="ftIncludeSub"' + (includeSub ? ' checked' : '') + '> 含子目录</label>' +
            '<span class="ft-spacer"></span>' +
            '<button class="ft-btn ft-btn-primary" id="ftNewFolder">＋ 新建文件夹</button>' +
            '<button class="ft-btn ft-btn-primary" id="ftImport">⬆ 导入文件</button>' +
            '<input type="file" id="ftFileInput" multiple style="display:none">' +
          '</div>' +
          '<div class="ft-crumb" id="ftCrumb"></div>' +
          '<div class="ft-grid" id="ftGrid"></div>' +
        '</section>' +
      '</div>';

    renderCrumb();
    renderGrid();
    bind(host);
  }

  function sideTreeHtml(cat, node, rel, depth) {
    var kids = (node.children || []).filter(function (c) { return c.type === 'folder'; })
      .map(function (c) { return sideTreeHtml(cat, c, rel ? rel + '/' + c.name : c.name, depth + 1); }).join('');
    return '<div class="ft-tnode' + (rel === curRel ? ' active' : '') + '" data-rel="' + esc(rel) + '" ' +
      'style="padding-left:' + (10 + depth * 14) + 'px">' +
      '<span class="ft-tic">📁</span><span class="ft-tname">' + esc(node.name) + '</span></div>' + kids;
  }

  function nodeChildrenAt(cat, rel) {
    var f = findFolder(cat, rel);
    return f ? (f.children || []) : [];
  }

  function renderCrumb() {
    var box = _host.querySelector('#ftCrumb');
    if (!box) return;
    var parts = splitPath(curRel);
    var crumb = '<span class="ft-crumb-cur" data-rel="">🗂 ' + esc(catTree(curCat).name) + '</span>';
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      crumb += '<span class="ft-sep">/</span><span class="ft-crumb-cur" data-rel="' + esc(acc) + '">' + esc(parts[i]) + '</span>';
    }
    box.innerHTML = crumb;
  }

  function renderGrid() {
    var grid = _host.querySelector('#ftGrid');
    if (!grid) return;
    var children = nodeChildrenAt(curCat, curRel);

    // 搜索：在「当前目录」或「含子目录」范围内过滤文件
    var folders = children.filter(function (c) { return c.type === 'folder'; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    var files = children.filter(function (c) { return c.type === 'file'; });

    if (keyword) {
      var k = keyword.toLowerCase();
      var matchedFiles = [];
      if (includeSub) matchedFiles = collectFiles(curCat, curRel).filter(function (f) { return f.name.toLowerCase().indexOf(k) >= 0; });
      else matchedFiles = files.filter(function (f) { return f.name.toLowerCase().indexOf(k) >= 0; });
      // 搜索时只显示匹配文件（不显示文件夹）
      folders = [];
      files = matchedFiles;
    } else {
      files = files.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    }

    if (!folders.length && !files.length) {
      grid.innerHTML = '<div class="ft-empty">' +
        (keyword ? '没有匹配「' + esc(keyword) + '」的文件。'
                 : '这个目录还是空的。点「＋ 新建文件夹」或「⬆ 导入文件」开始归档。') +
        '</div>';
      return;
    }

    var html = '';
    folders.forEach(function (f) {
      var rel = curRel ? curRel + '/' + f.name : f.name;
      var fc = countFiles(f);
      html += '<div class="ft-card ft-card-folder" data-goto="' + esc(rel) + '">' +
        '<div class="ft-card-ic">📁</div>' +
        '<div class="ft-card-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
        '<div class="ft-card-meta">' + fc + ' 个文件</div>' +
        '<div class="ft-card-acts">' +
          '<button class="ft-mini" data-act="rename-folder" data-name="' + esc(f.name) + '">重命名</button>' +
          '<button class="ft-mini ft-danger" data-act="del-folder" data-name="' + esc(f.name) + '">删除</button>' +
        '</div></div>';
    });

    files.forEach(function (f) {
      var kind = f.kind || kindOf(f.name);
      html += '<div class="ft-card ft-card-file">' +
        '<div class="ft-card-ic">' + kindIcon(kind) + '</div>' +
        '<div class="ft-card-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
        '<div class="ft-card-meta">' + kindName(kind) + (f.sizeText ? ' · ' + f.sizeText : '') + (f._pending ? ' · 待同步' : '') + '</div>' +
        '<div class="ft-card-acts">' +
          '<button class="ft-mini" data-act="preview" data-name="' + esc(f.name) + '">预览</button>' +
          '<button class="ft-mini" data-act="download" data-name="' + esc(f.name) + '">下载</button>' +
          '<button class="ft-mini ft-danger" data-act="del-file" data-name="' + esc(f.name) + '">删除</button>' +
        '</div></div>';
    });

    grid.innerHTML = html;
  }

  function collectFiles(cat, rel) {
    var out = [];
    (function walk(node) {
      (node.children || []).forEach(function (c) {
        if (c.type === 'file') out.push(c);
        else if (c.type === 'folder') walk(c);
      });
    })(findFolder(cat, rel) || { children: [] });
    return out;
  }
  function countFiles(node) {
    var c = 0;
    (function w(n) { (n.children || []).forEach(function (x) { if (x.type === 'file') c++; else w(x); }); })(node);
    return c;
  }

  /* ---------------- 事件 ---------------- */
  function bind(host) {
    if (host._ftBound) { rebindDynamic(); return; }
    host._ftBound = true;

    host.addEventListener('click', function (e) {
      var t = e.target;

      var mini = t.closest('[data-act]');
      if (mini) {
        var act = mini.getAttribute('data-act');
        var name = mini.getAttribute('data-name');
        if (act === 'rename-folder') doRenameFolder(name);
        else if (act === 'del-folder') doDeleteFolder(name);
        else if (act === 'preview') doPreview(name);
        else if (act === 'download') doDownload(name);
        else if (act === 'del-file') doDeleteFile(name);
        return;
      }

      var goto = t.closest('[data-goto]');
      if (goto) { curRel = goto.getAttribute('data-goto'); renderCrumb(); renderGrid(); updateSideActive(); return; }

      var crumbCur = t.closest('.ft-crumb-cur');
      if (crumbCur) { curRel = crumbCur.getAttribute('data-rel') || ''; renderCrumb(); renderGrid(); updateSideActive(); return; }

      var tnode = t.closest('.ft-tnode');
      if (tnode) { curRel = tnode.getAttribute('data-rel') || ''; renderCrumb(); renderGrid(); updateSideActive(); return; }

      if (t.closest('#ftNewFolder')) { doNewFolder(); return; }
      if (t.closest('#ftImport')) { var inp = host.querySelector('#ftFileInput'); if (inp) inp.click(); return; }
      if (t.closest('#ftSearchClr')) { keyword = ''; renderGrid(); var s = host.querySelector('#ftSearch'); if (s) s.value=''; return; }
      if (t.closest('.ft-link-connect')) { if (window.ISYS_Sync && window.ISYS_Sync.openConnect) window.ISYS_Sync.openConnect(); return; }
    });

    host.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'ftSearch') { keyword = e.target.value.trim(); renderGrid(); toggleClr(); }
    });
    host.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'ftIncludeSub') { includeSub = !!e.target.checked; renderGrid(); }
      if (e.target && e.target.id === 'ftFileInput') { handleImport(e.target.files); e.target.value = ''; }
    });
  }
  function rebindDynamic() { /* 事件委托已绑定一次，动态内容无需重绑 */ }
  function toggleClr() {
    var clr = _host.querySelector('#ftSearchClr');
    if (clr) clr.style.display = keyword ? '' : 'none';
  }
  function updateSideActive() {
    _host.querySelectorAll('.ft-tnode').forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-rel') === curRel);
    });
  }

  /* ---------------- 目录操作 ---------------- */
  function doNewFolder() {
    var name = prompt('新建文件夹名称：', '新建文件夹');
    if (name == null) return;
    var res = createFolder(curCat, curRel, name);
    if (!res.ok) { alert(res.msg); return; }
    if (connected()) persistTree();
    renderGrid(); updateSide();
    toast('已创建文件夹');
  }
  function doRenameFolder(oldName) {
    var name = prompt('重命名文件夹：', oldName);
    if (name == null) return;
    var res = renameNode(curCat, curRel, oldName, name);
    if (!res.ok) { alert(res.msg); return; }
    if (connected()) persistTree();
    // 若重命名的是当前目录，调整 curRel
    if (oldName === splitPath(curRel).pop()) {
      var parts = splitPath(curRel); parts[parts.length - 1] = name; curRel = parts.join('/');
    }
    renderCrumb(); renderGrid(); updateSide();
  }
  function doDeleteFolder(name) {
    if (!confirm('确定删除文件夹「' + name + '」及其全部内容？')) return;
    deleteNode(curCat, curRel, name);
    if (connected()) persistTree();
    renderGrid(); updateSide();
  }
  function doDeleteFile(name) {
    if (!confirm('确定删除文件「' + name + '」？')) return;
    deleteNode(curCat, curRel, name);
    if (connected()) persistTree();
    renderGrid();
  }

  function updateSide() {
    var side = _host.querySelector('.ft-tree');
    if (side) side.innerHTML = sideTreeHtml(curCat, root(curCat), '', 0);
    updateSideActive();
  }

  /* ---------------- 导入 + 预览 ---------------- */
  function handleImport(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var pending = [];
    files.forEach(function (file) {
      var kind = kindOf(file.name);
      var node = {
        type: 'file', name: file.name, kind: kind, sizeText: fmtSize(file.size),
        mtime: nowStr(), url: '', _pending: true, _file: file
      };
      // 未连接时：用 object URL 本次会话预览
      try { node.url = URL.createObjectURL(file); } catch (e) { node.url = ''; }
      addFile(curCat, curRel, node);
      pending.push({ node: node, file: file });
    });

    if (connected()) {
      // 逐个上传到仓库 /files/<cat>/<rel>/
      toast('正在上传 ' + pending.length + ' 个文件到 GitHub…');
      Promise.all(pending.map(function (p) {
        return uploadFile(curCat, curRel, p.file).then(function (url) {
          p.node.url = url; p.node._pending = false; delete p.node._file;
        }).catch(function (err) {
          p.node._pending = true; toast('上传失败：' + p.file.name + '（保留本次会话预览）');
        });
      })).then(function () {
        persistTree();
        renderGrid(); toast('已上传并保存');
      });
    } else {
      toast('未连接 GitHub：' + pending.length + ' 个文件仅本次会话预览，连接后自动持久化');
      renderGrid();
    }
  }

  function findFileNode(name) {
    var children = nodeChildrenAt(curCat, curRel);
    for (var i = 0; i < children.length; i++) if (children[i].type === 'file' && children[i].name === name) return children[i];
    return null;
  }

  function doDownload(name) {
    var f = findFileNode(name);
    if (!f || !f.url) return;
    var a = document.createElement('a');
    a.href = f.url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  var _pv = null;
  function ensureModal() {
    if (_pv) return _pv;
    var m = document.createElement('div');
    m.className = 'ft-modal';
    m.innerHTML =
      '<div class="ft-modal-mask" data-close="1"></div>' +
      '<div class="ft-modal-box">' +
        '<div class="ft-modal-head">' +
          '<span class="ft-modal-ic"></span><b class="ft-modal-title"></b>' +
          '<span class="ft-modal-meta"></span><span class="ft-modal-spacer"></span>' +
          '<button class="ft-mini" data-dl="1">⬇ 下载</button>' +
          '<button class="ft-modal-x" data-close="1">✕</button>' +
        '</div>' +
        '<div class="ft-modal-body"></div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-close]')) { closePreview(); return; }
      if (t.closest('[data-dl]') && _pvFile) { doDownload(_pvFile); return; }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePreview(); });
    _pv = m; return m;
  }
  function closePreview() { if (_pv) { _pv.classList.remove('show'); var b = _pv.querySelector('.ft-modal-body'); if (b) b.innerHTML = ''; } _pvFile = null; }
  var _pvFile = null;

  function doPreview(name) {
    var f = findFileNode(name);
    if (!f) return;
    _pvFile = name;
    var m = ensureModal();
    m.querySelector('.ft-modal-ic').textContent = kindIcon(f.kind || kindOf(name));
    m.querySelector('.ft-modal-title').textContent = name;
    m.querySelector('.ft-modal-meta').textContent = kindName(f.kind || kindOf(name)) + (f.sizeText ? ' · ' + f.sizeText : '');
    var body = m.querySelector('.ft-modal-body');
    var kind = f.kind || kindOf(name);
    if (!f.url) { body.innerHTML = '<div class="ft-pv-none">文件不可用，请重新导入。</div>'; m.classList.add('show'); return; }

    if (kind === 'image') {
      body.innerHTML = '<img class="ft-pv-img" src="' + esc(f.url) + '" alt="' + esc(name) + '">';
    } else if (kind === 'video') {
      body.innerHTML = '<video class="ft-pv-media" src="' + esc(f.url) + '" controls></video>';
    } else if (kind === 'audio') {
      body.innerHTML = '<audio class="ft-pv-media" src="' + esc(f.url) + '" controls></audio>';
    } else if (kind === 'pdf') {
      body.innerHTML = '<iframe class="ft-pv-frame" src="' + esc(f.url) + '"></iframe>' +
        '<div class="ft-pv-hint">若浏览器未内嵌显示 PDF，可点右上角「⬇ 下载」查看。</div>';
    } else if (kind === 'text') {
      body.innerHTML = '<div class="ft-pv-loading">读取中…</div>';
      fetchText(f.url).then(function (txt) {
        body.innerHTML = '<pre class="ft-pv-text">' + esc(txt.length > 200000 ? txt.slice(0, 200000) + '\n…（已截断，完整内容请下载）' : txt) + '</pre>';
      }).catch(function () { body.innerHTML = '<div class="ft-pv-none">无法读取文本内容，<a class="ft-link" href="' + esc(f.url) + '" target="_blank">点此下载</a>。</div>'; });
    } else {
      body.innerHTML = '<div class="ft-pv-none">' + kindIcon(kind) +
        '<p>「' + kindName(kind) + '」暂不支持页面内预览。</p>' +
        '<p class="ft-pv-hint"><a class="ft-link" href="' + esc(f.url) + '" target="_blank">点此在新窗口打开 / 下载</a>。</p></div>';
    }
    m.classList.add('show');
  }

  function fetchText(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }

  /* ---------------- 提示 ---------------- */
  function toast(msg) {
    var t = document.getElementById('ftToast');
    if (!t) { t = document.createElement('div'); t.id = 'ftToast'; t.className = 'ft-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  window.ISYS_FileTree = {
    render: render,
    bootstrap: bootstrap,
    reset: function () { curRel = ''; keyword = ''; includeSub = false; }
  };
})();
