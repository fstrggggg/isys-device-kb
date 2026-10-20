/* ============================================================
 * ISYS 知识库 —— 「文件库」页（索引式）
 *
 * 设计：真实文件放在公司共享目录，网页只展示“索引”。
 *       索引由 index_isys_files.ps1 扫描共享目录生成到 files-index.js
 *       （window.ISYS_FILE_INDEX，扁平文件列表，含 rel 相对路径与 url）。
 *
 * 能力：左侧项目/文件夹树（带文件数角标）、右侧文件列表；
 *       关键字搜索、含子文件夹开关；图片/PDF/文本/视频/音频 内联预览；
 *       新窗口打开、复制共享路径。
 *
 * 事件只绑定一次（宿主元素上做委托），搜索时只刷新列表，避免重复绑定与丢焦点。
 * 与 app.js 的 renderFileLib 对接。
 * ============================================================ */
(function () {
  'use strict';

  var INCLUDE_SUB = false;   // 是否包含子目录文件
  var selFolder = '';        // 当前选中文件夹相对路径（'' = 根）
  var keyword = '';
  var _root = null;          // 当前文件夹树
  var _node = null;          // 当前选中节点

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function index() {
    return (typeof window.ISYS_FILE_INDEX !== 'undefined' && window.ISYS_FILE_INDEX)
      ? window.ISYS_FILE_INDEX : null;
  }

  function kindIcon(kind) {
    switch (kind) {
      case 'image':   return '🖼️';
      case 'pdf':     return '📕';
      case 'text':    return '📄';
      case 'archive': return '🗜️';
      case 'office':  return '📊';
      case 'video':   return '🎬';
      case 'audio':   return '🎵';
      default:        return '📎';
    }
  }

  function kindName(kind) {
    switch (kind) {
      case 'image': return '图片';
      case 'pdf': return 'PDF';
      case 'text': return '文本';
      case 'archive': return '压缩包';
      case 'office': return 'Office 文档';
      case 'video': return '视频';
      case 'audio': return '音频';
      default: return '文件';
    }
  }

  /* 真实磁盘路径（“复制路径”后粘到资源管理器可直接定位） */
  function realPath(file) {
    var idx = index();
    var base = (idx && idx.root) ? String(idx.root) : '';
    return base.replace(/[\\/]+$/, '') + '\\' + String(file.rel).replace(/\//g, '\\');
  }

  /* 由扁平列表构建文件夹树，递归统计文件数 */
  function buildTree(files) {
    var root = { name: '文件库', rel: '', folders: {}, files: [], count: 0 };
    files.forEach(function (f) {
      var parts = String(f.rel).split('/');
      parts.pop();
      var node = root;
      parts.forEach(function (p) {
        if (!node.folders[p]) {
          node.folders[p] = {
            name: p,
            rel: node.rel ? (node.rel + '/' + p) : p,
            folders: {}, files: [], count: 0
          };
        }
        node = node.folders[p];
      });
      node.files.push(f);
    });
    (function count(n) {
      var c = n.files.length;
      Object.keys(n.folders).forEach(function (k) { c += count(n.folders[k]); });
      n.count = c;
      return c;
    })(root);
    return root;
  }

  function findNode(root, rel) {
    if (!root) return null;
    if (!rel) return root;
    var node = root;
    String(rel).split('/').forEach(function (p) {
      node = (node && node.folders[p]) ? node.folders[p] : null;
    });
    return node;
  }

  function match(f) {
    if (!keyword) return true;
    var k = keyword.toLowerCase();
    return String(f.name).toLowerCase().indexOf(k) >= 0 ||
           String(f.rel).toLowerCase().indexOf(k) >= 0;
  }

  function filesOf(node) {
    var out = [];
    (function walk(n) {
      n.files.forEach(function (f) { if (match(f)) out.push(f); });
      if (INCLUDE_SUB) Object.keys(n.folders).forEach(function (k) { walk(n.folders[k]); });
    })(node);
    return out;
  }

  function sortedFolders(node) {
    return Object.keys(node.folders)
      .sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); })
      .map(function (k) { return node.folders[k]; });
  }

  function treeHtml(node, depth) {
    var kids = sortedFolders(node).map(function (c) { return treeHtml(c, depth + 1); }).join('');
    var self = '<div class="fl-node' + (node.rel === selFolder ? ' active' : '') + '" ' +
      'data-rel="' + esc(node.rel) + '" style="padding-left:' + (10 + depth * 14) + 'px" ' +
      'title="' + esc(node.name) + '">' +
      '<span class="fl-ic">📁</span>' +
      '<span class="fl-name">' + esc(node.name) + '</span>' +
      '<span class="fl-cnt">' + node.count + '</span>' +
    '</div>';
    return self + (kids ? '<div class="fl-kids">' + kids + '</div>' : '');
  }

  function folderRowHtml(node) {
    return '<div class="fl-folder-row" data-open="' + esc(node.rel) + '">' +
      '<span class="fl-ic">📁</span>' +
      '<span class="fl-name">' + esc(node.name) + '</span>' +
      '<span class="fl-cnt">' + node.count + ' 个文件</span>' +
    '</div>';
  }

  function fileRowHtml(f) {
    return '<div class="fl-file-row" data-id="' + esc(f.rel) + '">' +
      '<span class="fl-ic">' + kindIcon(f.kind) + '</span>' +
      '<span class="fl-fname" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
      '<span class="fl-kind">' + kindName(f.kind) + '</span>' +
      '<span class="fl-size">' + esc(f.sizeText) + '</span>' +
      '<span class="fl-mtime">' + esc(f.mtime) + '</span>' +
      '<span class="fl-acts">' +
        '<button class="fl-btn" data-act="preview" title="在页面内预览">👁 预览</button>' +
        '<button class="fl-btn" data-act="open" title="用浏览器 / 默认程序打开">↗ 打开</button>' +
        '<button class="fl-btn" data-act="copy" title="复制共享路径">⧉ 路径</button>' +
      '</span>' +
    '</div>';
  }

  function listHtml(node) {
    var subs = sortedFolders(node).map(folderRowHtml).join('');
    var files = filesOf(node).map(fileRowHtml).join('');
    var empty = (!subs && !files)
      ? '<div class="fl-empty">' +
          (keyword
            ? '没有匹配「' + esc(keyword) + '」的文件。'
            : '这个目录还是空的。把文件放进共享目录的对应文件夹，重新生成索引并发布即可。') +
        '</div>'
      : '';
    return subs + files + empty;
  }

  function fmtTotal(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* ---------------- 预览弹窗 ---------------- */
  var _cur = null;

  function ensureModal() {
    var m = document.getElementById('flModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'flModal';
    m.className = 'fl-modal';
    m.innerHTML =
      '<div class="fl-modal-mask" data-close="1"></div>' +
      '<div class="fl-modal-box">' +
        '<div class="fl-modal-head">' +
          '<span class="fl-modal-icon"></span>' +
          '<b class="fl-modal-title"></b>' +
          '<span class="fl-modal-meta"></span>' +
          '<span class="fl-modal-spacer"></span>' +
          '<button class="fl-btn" data-open-cur="1">↗ 新窗口打开</button>' +
          '<button class="fl-btn" data-copy-cur="1">⧉ 复制路径</button>' +
          '<button class="fl-modal-x" data-close="1" title="关闭">✕</button>' +
        '</div>' +
        '<div class="fl-modal-body"></div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-close]')) { closePreview(); return; }
      if (t.closest('[data-open-cur]')) { if (_cur) window.open(_cur.url, '_blank'); return; }
      if (t.closest('[data-copy-cur]')) { if (_cur) copyText(realPath(_cur), '已复制共享路径'); return; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePreview();
    });
    return m;
  }

  function closePreview() {
    var m = document.getElementById('flModal');
    if (!m) return;
    m.classList.remove('show');
    var b = m.querySelector('.fl-modal-body');
    if (b) b.innerHTML = '';
    _cur = null;
  }

  function openPreview(f) {
    _cur = f;
    var m = ensureModal();
    m.querySelector('.fl-modal-icon').textContent = kindIcon(f.kind);
    m.querySelector('.fl-modal-title').textContent = f.name;
    m.querySelector('.fl-modal-meta').textContent =
      kindName(f.kind) + ' · ' + f.sizeText + ' · ' + f.mtime;
    var body = m.querySelector('.fl-modal-body');
    var html;
    if (f.kind === 'image') {
      html = '<img class="fl-pv-img" src="' + esc(f.url) + '" alt="' + esc(f.name) + '">';
    } else if (f.kind === 'pdf' || f.kind === 'text') {
      html = '<iframe class="fl-pv-frame" src="' + esc(f.url) + '" title="' + esc(f.name) + '"></iframe>';
    } else if (f.kind === 'video') {
      html = '<video class="fl-pv-video" src="' + esc(f.url) + '" controls></video>';
    } else if (f.kind === 'audio') {
      html = '<audio class="fl-pv-audio" src="' + esc(f.url) + '" controls></audio>';
    } else {
      html = '<div class="fl-pv-none">' + kindIcon(f.kind) +
        '<p>「' + kindName(f.kind) + '」暂不支持在页面内预览。</p>' +
        '<p class="fl-pv-hint">可点右上角「新窗口打开」，或「复制路径」后在资源管理器中打开。</p>' +
        '<p class="fl-pv-path">' + esc(realPath(f)) + '</p></div>';
    }
    body.innerHTML = html;
    m.classList.add('show');
  }

  /* ---------------- 复制 / 提示 ---------------- */
  function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast(okMsg); },
          function () { fallbackCopy(text, okMsg); }
        );
      } else {
        fallbackCopy(text, okMsg);
      }
    } catch (e) { fallbackCopy(text, okMsg); }
  }

  function fallbackCopy(text, okMsg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('复制失败，请手动复制'); }
    document.body.removeChild(ta);
  }

  function toast(msg) {
    var t = document.getElementById('flToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'flToast';
      t.className = 'fl-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }

  /* ---------------- 渲染 ---------------- */
  function render(host) {
    host = host || document.getElementById('fileLibHost');
    if (!host) return;
    host.classList.add('file-lib-host');

    var idx = index();
    if (!idx || !idx.files) {
      host.innerHTML = '<div class="fl-empty fl-empty-big">' +
        '<div class="fl-empty-ic">📁</div>' +
        '<h3>尚未生成文件索引</h3>' +
        '<p>请先运行 <code>index_isys_files.ps1</code> 扫描共享目录生成 <code>files-index.js</code>，再重新发布。</p>' +
        '</div>';
      return;
    }

    _root = buildTree(idx.files);
    if (selFolder && !findNode(_root, selFolder)) selFolder = '';
    _node = findNode(_root, selFolder) || _root;

    var totalSize = 0;
    idx.files.forEach(function (f) { totalSize += (f.size || 0); });

    var crumb = '<span class="fl-crumb-cur" data-open="">🗂 全部</span>';
    if (selFolder) {
      var acc = '';
      String(selFolder).split('/').forEach(function (p) {
        acc = acc ? (acc + '/' + p) : p;
        crumb += '<span class="fl-sep">/</span>' +
          '<span class="fl-crumb-cur" data-open="' + esc(acc) + '">' + esc(p) + '</span>';
      });
    }

    host.innerHTML =
      '<div class="fl-wrap">' +
        '<aside class="fl-side">' +
          '<div class="fl-side-head">项目 / 目录<span class="fl-side-num">' + _root.count + ' 个文件</span></div>' +
          '<div class="fl-tree">' + treeHtml(_root, 0) + '</div>' +
        '</aside>' +
        '<section class="fl-main">' +
          '<div class="fl-toolbar">' +
            '<div class="fl-search"><span>🔍</span>' +
              '<input type="text" id="flSearch" placeholder="搜索文件名…" value="' + esc(keyword) + '" autocomplete="off">' +
              (keyword ? '<button class="fl-clr" id="flSearchClr" title="清空">×</button>' : '') +
            '</div>' +
            '<label class="fl-chk"><input type="checkbox" id="flIncludeSub"' + (INCLUDE_SUB ? ' checked' : '') + '> 含子文件夹</label>' +
            '<span class="fl-stat">共 ' + idx.files.length + ' 个文件 · ' + idx.totalFolders + ' 个文件夹 · ' + fmtTotal(totalSize) + '</span>' +
            '<button class="fl-btn" id="flCopyRoot" title="复制共享目录路径">⧉ 复制共享目录</button>' +
          '</div>' +
          '<div class="fl-root-line" title="' + esc(idx.root) + '">📂 ' + esc(idx.root) +
            '<span class="fl-gen">索引生成：' + esc(idx.generatedAt) + '</span></div>' +
          '<div class="fl-crumb">' + crumb + '</div>' +
          '<div class="fl-list">' + listHtml(_node) + '</div>' +
        '</section>' +
      '</div>';

    bindHost(host);
  }

  function refreshList(host) {
    var box = host.querySelector('.fl-list');
    if (!box || !_node) return;
    box.innerHTML = listHtml(_node);
  }

  function bindHost(host) {
    if (host._flBound) return;
    host._flBound = true;

    host.addEventListener('click', function (e) {
      var t = e.target;
      var actBtn = t.closest('[data-act]');
      var fileRow = t.closest('.fl-file-row');
      if (actBtn && fileRow) {
        var f = findFile(fileRow.getAttribute('data-id'));
        if (!f) return;
        var act = actBtn.getAttribute('data-act');
        if (act === 'preview') openPreview(f);
        else if (act === 'open') window.open(f.url, '_blank');
        else if (act === 'copy') copyText(realPath(f), '已复制共享路径');
        return;
      }
      var opener = t.closest('[data-open]');
      if (opener) {
        selFolder = opener.getAttribute('data-open') || '';
        render(host);
        return;
      }
      var treeNode = t.closest('.fl-node');
      if (treeNode) {
        selFolder = treeNode.getAttribute('data-rel') || '';
        render(host);
        return;
      }
      if (t.closest('#flCopyRoot')) {
        var idx = index();
        if (idx) copyText(idx.root, '已复制共享目录路径');
        return;
      }
      if (t.closest('#flSearchClr')) {
        keyword = '';
        render(host);
        return;
      }
    });

    host.addEventListener('input', function (e) {
      if (!e.target || e.target.id !== 'flSearch') return;
      keyword = e.target.value.trim();
      refreshList(host);
      var clr = host.querySelector('#flSearchClr');
      if (clr) clr.style.display = keyword ? '' : 'none';
    });

    host.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'flIncludeSub') return;
      INCLUDE_SUB = !!e.target.checked;
      refreshList(host);
    });
  }

  function findFile(rel) {
    var idx = index();
    if (!idx) return null;
    for (var i = 0; i < idx.files.length; i++) if (idx.files[i].rel === rel) return idx.files[i];
    return null;
  }

  window.ISYS_FileLib = {
    render: render,
    reset: function () { selFolder = ''; keyword = ''; INCLUDE_SUB = false; }
  };
})();
