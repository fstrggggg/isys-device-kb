/* ============================================================
 * ISYS 器件开发知识库 —— 渲染与交互逻辑
 * 数据全部来自 data.js（内置 JS 数组），无后端
 *
 * 哈希路由：
 *   #/<pageId>                      打开指定页面
 *   #/<pageId>/focus/<型号>         打开页面并聚焦指定型号（显示重点信息卡片）
 * ============================================================ */

(function () {
  'use strict';

  const PLACEHOLDER = '—';
  const ALL = '__all__';

  const els = {
    tree:        document.getElementById('treeNav'),
    breadcrumb:  document.getElementById('breadcrumb'),
    pageTitle:   document.getElementById('pageTitle'),
    pageDesc:    document.getElementById('pageDesc'),
    overview:    document.getElementById('overviewCards'),
    dataSection: document.getElementById('dataSection'),
    focusCard:   document.getElementById('focusCard'),
    stats:       document.getElementById('stats'),
    search:      document.getElementById('searchInput'),
    clearSearch: document.getElementById('clearSearch'),
    filter:      document.getElementById('typeFilter'),
    filterLabel: document.getElementById('filterLabel'),
    rowCount:    document.getElementById('rowCount'),
    exportBtn:   document.getElementById('exportBtn'),
    tableWrap:   document.querySelector('.table-wrap'),
    table:       document.getElementById('dataTable'),
    tableHead:   document.getElementById('tableHead'),
    tableBody:   document.getElementById('tableBody'),
    emptyState:  document.getElementById('emptyState'),
    sidebar:     document.getElementById('sidebar'),
    sideToggle:  document.getElementById('sidebarToggle'),
    collapseAll: document.getElementById('collapseAll'),
    topDate:     document.getElementById('topbarDate'),
    content:     document.getElementById('content')
  };

  /* 一级设备分组默认展开状态 */
  const expanded = { module: true, secondary: true };
  let currentPageId = null;   // 当前页面 id
  let currentFocus = null;    // 当前聚焦型号（跨库跳转用）
  let pageMap = {};           // id -> {page, parent}
  let filters = {};           // 表头筛选行的列筛选值：{ 列key: 值 }

  /* ---------------- 构建索引（云端热替换数据后也可重新调用） ---------------- */
  function buildIndex() {
    pageMap = {};
    LIBRARIES.forEach(function (lib) {
      if (lib.children) {
        lib.children.forEach(function (child) {
          pageMap[child.id] = { page: child, parent: lib };
        });
      } else {
        pageMap[lib.id] = { page: lib, parent: null };
      }
    });
  }

  /* ---------------- 左侧树形导航 ---------------- */
  function renderTree() {
    const nav = window.ISYS_NAV || { groups: [], fileRoots: [] };
    let html = '';

    /* 设备分组：模组资料库 / 二级器件（子项复用 data.js 的页面） */
    (nav.groups || []).forEach(function (g) {
      const isOpen = expanded[g.id] !== false;   // 默认展开
      const items = (g.children || []).map(function (cid) {
        const entry = pageMap[cid];
        if (!entry) return '';
        const page = entry.page;
        const cnt = (page.rows || []).length;
        return '<li class="tree-leaf">' +
          '<a class="tree-link" data-page="' + cid + '" href="#/' + cid + '" title="' + escapeHtml(page.name) + '">' +
          '<span class="dot"></span>' + escapeHtml(page.name) +
          '<span class="cnt">' + cnt + '</span></a></li>';
      }).join('');
      html += '<div class="tree-group' + (isOpen ? ' open' : '') + '" data-group="' + g.id + '">' +
        '<div class="tree-parent" data-toggle="' + g.id + '">' +
          '<span class="arrow">▸</span>' +
          '<span class="ico">' + escapeHtml(g.icon || '📁') + '</span>' +
          '<span class="name">' + escapeHtml(g.name) + '</span>' +
        '</div>' +
        '<ul class="tree-children"' + (isOpen ? '' : ' style="display:none"') + '>' + items + '</ul>' +
      '</div>';
    });

    /* 文件型一级目录：项目管理 / 知识库 / 工具 / 标准化管理 */
    (nav.fileRoots || []).forEach(function (fr) {
      html += '<div class="tree-group">' +
        '<a class="tree-parent link" data-page="' + fr.id + '" href="#/' + fr.id + '" title="' + escapeHtml(fr.name) + '">' +
          '<span class="arrow placeholder"></span>' +
          '<span class="ico">' + escapeHtml(fr.icon || '📁') + '</span>' +
          '<span class="name">' + escapeHtml(fr.name) + '</span>' +
        '</a></div>';
    });

    els.tree.innerHTML = html;
  }

  function highlightActive() {
    document.querySelectorAll('.tree-link, .tree-parent.link').forEach(function (a) {
      a.classList.toggle('active', a.dataset.page === currentPageId);
    });
    document.querySelectorAll('.tree-group').forEach(function (g) {
      const hasActive = !!g.querySelector('.tree-link.active');
      const parentEl = g.querySelector('.tree-parent');
      if (parentEl) parentEl.classList.toggle('has-active', hasActive);
    });
  }

  /* ---------------- 路由解析 ---------------- */
  function parseHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const seg = raw.split('/').filter(Boolean).map(safeDecode);
    return {
      id: seg[0] || defaultId(),
      focus: (seg[1] === 'focus' && seg[2]) ? seg[2] : null
    };
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function defaultId() {
    const nav = window.ISYS_NAV;
    if (nav && nav.groups && nav.groups[0] && nav.groups[0].children && nav.groups[0].children[0]) {
      return nav.groups[0].children[0];
    }
    return LIBRARIES[0].children ? LIBRARIES[0].children[0].id : LIBRARIES[0].id;
  }

  /* ---------------- 页面渲染 ---------------- */
  function isFileRoot(id) {
    const nav = window.ISYS_NAV;
    if (!nav || !nav.fileRoots) return false;
    return nav.fileRoots.some(function (f) { return f.id === id; });
  }

  function renderFileTree(catId) {
    currentPageId = catId;
    currentFocus = null;
    els.content.scrollTop = 0;
    const fr = (window.ISYS_NAV.fileRoots || []).filter(function (f) { return f.id === catId; })[0];
    if (!fr) { location.hash = '#/' + defaultId(); return; }
    els.breadcrumb.innerHTML = '<span class="cur">' + escapeHtml(fr.name) + '</span>';
    els.pageTitle.textContent = (fr.icon || '📁') + ' ' + fr.name;
    els.pageDesc.textContent = fr.desc || '';
    els.overview.hidden = true;
    els.focusCard.hidden = true;
    els.dataSection.hidden = true;

    let host = document.getElementById('fileTreeHost');
    if (!host) {
      host = document.createElement('section');
      host.id = 'fileTreeHost';
      host.className = 'file-lib-host';
      els.content.appendChild(host);
    }
    host.hidden = false;
    if (window.ISYS_FileTree) window.ISYS_FileTree.render(host, catId);
    highlightActive();
  }

  function renderPage(id, focus) {
    if (isFileRoot(id)) { renderFileTree(id); return; }
    const flh = document.getElementById('fileLibHost');
    if (flh) flh.hidden = true;
    const fth = document.getElementById('fileTreeHost');
    if (fth) fth.hidden = true;
    const entry = pageMap[id];
    if (!entry) { location.hash = '#/' + defaultId(); return; }

    currentPageId = id;
    currentFocus = focus || null;

    const page = entry.page;
    const parent = entry.parent;

    els.breadcrumb.innerHTML = parent
      ? '<a href="#/' + parent.id + '">' + parent.name + '</a><span class="sep">/</span><span class="cur">' + page.name + '</span>' +
        (currentFocus ? '<span class="sep">/</span><span class="cur">聚焦 ' + escapeHtml(currentFocus) + '</span>' : '')
      : '<span class="cur">' + page.name + '</span>' +
        (currentFocus ? '<span class="sep">/</span><span class="cur">聚焦 ' + escapeHtml(currentFocus) + '</span>' : '');

    els.pageTitle.textContent = page.name;
    els.pageDesc.textContent = page.desc || '';
    els.content.scrollTop = 0;

    if (parent) {
      els.overview.hidden = false;
      els.dataSection.hidden = false;
      renderOverview(parent);
    } else if (page.children) {
      els.overview.hidden = false;
      els.dataSection.hidden = true;
      renderOverview(page);
    } else {
      els.overview.hidden = true;
      els.dataSection.hidden = false;
    }

    if (!els.dataSection.hidden) {
      renderTable(page);
      resetToolbar(page);
      renderFocusCard(page, currentFocus);
      drawRows();          // 放在最后：内部会把聚焦行滚动到可视区
      fitTableHeight();
    }

    highlightActive();
  }

  function renderOverview(lib) {
    const cards = lib.children.map(function (c) {
      return '<a class="ov-card" href="#/' + c.id + '">' +
        '<div class="ov-title">' + c.name + '</div>' +
        '<div class="ov-num">' + c.rows.length + '<span>条记录</span></div>' +
        '<div class="ov-sub">' + (c.columns.length + 1) + ' 个字段 · 点击进入</div>' +
      '</a>';
    }).join('');
    els.overview.innerHTML = cards;
  }

  /* 生成行数据（示例数据 + 占位行） */
  function buildRows(page) {
    const rows = page.rows.map(function (r) {
      const copy = {};
      page.columns.forEach(function (c) { copy[c.key] = r[c.key] || ''; });
      return copy;
    });
    const n = page.placeholder || 0;
    for (let i = 0; i < n; i++) {
      const empty = {};
      page.columns.forEach(function (c) { empty[c.key] = PLACEHOLDER; });
      rows.push(empty);
    }
    return rows;
  }

  /* 编辑模式（由 editor.js 提供，脚本未加载或已锁定时恒为 false） */
  function editMode() {
    return !!(window.ISYS_Edit && window.ISYS_Edit.active && window.ISYS_Edit.active());
  }

  /* ============================================================
   * 列宽 / 行高自适应
   *   行高：由 CSS 负责（单元格允许换行，内容多高行就多高）
   *   列宽：这里量出每列「最长内容」的自然宽度，写成 <colgroup> 的像素宽；
   *         表格用 table-layout: fixed，列宽即我们所算，超出上限的内容换行。
   *   重算时机：切库 / 改数据 / 改列结构 / 窗口尺寸变化（脏标记避免每次筛选都重算）
   * ============================================================ */
  const FIT = {
    no: 56,        // NO. 列
    act: 112,      // 编辑模式下的操作列
    floor: 64,     // 单列绝对下限
    cap: 420,      // 单列上限，再长就换行（行高自适应）
    pad: 28,       // 单元格左右 padding + 余量
    headPad: 34,   // 表头列名留白（含可能的排序空间）
    linkPad: 16,   // 可跳转列多出一个 ↗ 箭头
    sample: 8      // 每列只精确测量「字符数最长」的若干个值，避免大表反复重排
  };

  let fitWidths = [];    // 当前页各数据列的像素宽
  let fitPageId = null;  // fitWidths 属于哪个页面
  let fitDirty = true;   // 数据/列结构变了需要重算
  let cgSig = '';        // 已写入 DOM 的 colgroup 签名，避免重复写
  let probeEl = null;    // 量文字宽度的探针

  function textWidth(s) {
    const str = (s === null || s === undefined) ? '' : String(s);
    if (!str) return 0;
    if (!probeEl) {
      probeEl = document.createElement('span');
      probeEl.className = 'col-fit-probe';
      document.body.appendChild(probeEl);
    }
    probeEl.textContent = str;
    return probeEl.offsetWidth || 0;
  }

  /* 一段文字里「最长的一行」有多长：单元格允许换行，列宽只取决于它 */
  function longestLine(s) {
    const parts = String(s).split(/\r?\n/);
    let m = 0;
    for (let i = 0; i < parts.length; i++) if (parts[i].length > m) m = parts[i].length;
    return m;
  }

  /* 每列取「表头列名」与「所有数据行内容」里最宽的一个，夹在下限与上限之间 */
  function computeWidths(page) {
    const cols = page.columns;
    const rows = page.rows;
    return cols.map(function (c) {
      const lo = parseInt(c.width, 10) || FIT.floor;
      const hi = parseInt(c.maxWidth, 10) || FIT.cap;

      /* 先按字符数粗筛出最长的几个候选，只对它们做精确测量：
         表格涨到几百行时也不会因为反复读写 offsetWidth 触发大量重排 */
      /* 用户手动拖过宽度的列：固定用他拖出来的值，不再参与自动量算 */
      if (c.userWidth) return Math.max(FIT.floor, Math.round(c.userWidth));

      const cand = [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][c.key];
        if (v === null || v === undefined || v === '') continue;
        cand.push(String(v));
      }
      /* 单元格支持框内换行，所以按「最长的一行」排序 / 量算，
         而不是整段文字的总长度 —— 否则一换行就把列撑得很宽 */
      cand.sort(function (a, b) { return longestLine(b) - longestLine(a); });

      let need = textWidth(c.label) + FIT.headPad + (c.link ? FIT.linkPad : 0);
      const n = Math.min(cand.length, FIT.sample);
      for (let i = 0; i < n; i++) {
        const lines = String(cand[i]).split(/\r?\n/);
        for (let j = 0; j < lines.length; j++) {
          const w = textWidth(lines[j]);
          if (w > need) need = w;
        }
      }
      return Math.max(lo, Math.min(hi, Math.round(need + FIT.pad)));
    });
  }

  function fitColumns(force) {
    if (!els.table) return;
    const pid = currentPageId;
    if (!force && !fitDirty && fitPageId === pid) return;
    const page = pageMap[pid];
    if (!page) return;
    const w = computeWidths(page.page);
    let total = FIT.no + (editMode() ? FIT.act : 0);
    w.forEach(function (x) { total += x; });

    /* 容器还有富余就按比例分给「没被手动定宽」的列，保证表格铺满；
       手动定宽的列保持用户拖出来的值不动。容器尚未布局（宽度为 0）时跳过。 */
    const avail = els.tableWrap ? els.tableWrap.clientWidth : 0;
    const autoIdx = [];
    page.page.columns.forEach(function (c, i) { if (!c.userWidth) autoIdx.push(i); });

    if (avail > 0 && total < avail && autoIdx.length) {
      let sum = 0;
      autoIdx.forEach(function (i) { sum += w[i]; });
      sum = sum || 1;
      const extra = avail - total;
      let used = 0;
      autoIdx.forEach(function (i, k) {
        const add = (k === autoIdx.length - 1) ? extra - used : Math.round(extra * w[i] / sum);
        w[i] += add;
        used += add;
      });
    }

    fitWidths = w;
    fitDirty = false;
    fitPageId = pid;
  }

  function applyColgroup() {
    if (!els.table) return;
    let cg = els.table.querySelector('colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      els.table.insertBefore(cg, els.table.firstChild);
    }
    const parts = ['<col style="width:' + FIT.no + 'px">'];
    fitWidths.forEach(function (w) { parts.push('<col style="width:' + w + 'px">'); });
    if (editMode()) parts.push('<col style="width:' + FIT.act + 'px">');

    /* 各列定宽之和超过容器时，把表格撑到实际总宽，交给 .table-wrap 横向滚动；
       否则保持 width:100%，由浏览器按比例分配（总和更小时才不会与 colgroup 打架）。 */
    let total = FIT.no + (editMode() ? FIT.act : 0);
    fitWidths.forEach(function (w) { total += w; });
    const avail = els.tableWrap ? els.tableWrap.clientWidth : 0;
    els.table.style.width = (avail > 0 && total > avail) ? total + 'px' : '';

    const html = parts.join('');
    if (html === cgSig && cg.children.length) return;
    cgSig = html;
    cg.innerHTML = html;
  }

  /* 数据或列结构变化后由外部调用，标记下次渲染时重算列宽 */
  function markFitDirty() { fitDirty = true; }

  /* ============================================================
   * 列宽拖拽
   *   表头每个数据列的右边缘有 8px 热区，按住左右拖即可定宽。
   *   定宽值写在列配置的 userWidth 上（共用同一份列定义的库会一起生效），
   *   之后该列不再参与自动量算；双击把手恢复自动。
   *   拖动过程中只改 <colgroup>，不重算不重绘，避免大表卡顿。
   * ============================================================ */
  const RS = { min: 60, max: 900 };
  let rs = null;                 // 拖拽中的状态

  function curCols() {
    const p = pageMap[currentPageId];
    return p ? p.page.columns : [];
  }

  function colIdx(key) {
    const cs = curCols();
    for (let i = 0; i < cs.length; i++) if (cs[i].key === key) return i;
    return -1;
  }

  function clampW(w) {
    return Math.max(RS.min, Math.min(RS.max, Math.round(w)));
  }

  function onResizeStart(e) {
    if (e.button != null && e.button !== 0) return;          // 只响应左键
    const h = (e.target && e.target.closest) ? e.target.closest('.col-resize') : null;
    if (!h) return;
    const key = h.dataset.col;
    const i = colIdx(key);
    if (i < 0 || i >= fitWidths.length) return;
    e.preventDefault();
    e.stopPropagation();
    rs = { key: key, i: i, startX: e.clientX, startW: fitWidths[i], w: fitWidths[i], moved: false };
    document.body.classList.add('col-resizing');
  }

  function onResizeMove(e) {
    if (!rs) return;
    const w = clampW(rs.startW + (e.clientX - rs.startX));
    if (w === rs.w) return;
    rs.w = w;
    rs.moved = true;
    fitWidths[rs.i] = w;
    applyColgroup();
  }

  function onResizeEnd() {
    if (!rs) return;
    const r = rs;
    rs = null;
    document.body.classList.remove('col-resizing');
    if (r.moved) setColWidth(r.key, r.w);
  }

  /* 落库：写进列配置 → 重算 → 持久化（本地缓存，随 data.js 导出一起带走） */
  function commitWidths() {
    markFitDirty();
    fitColumns(true);
    applyColgroup();
    if (window.ISYS_Edit && typeof window.ISYS_Edit.persist === 'function') window.ISYS_Edit.persist();
  }

  function setColWidth(key, w) {
    const c = curCols().filter(x => x.key === key)[0];
    if (!c) return false;
    c.userWidth = clampW(w);
    commitWidths();
    return true;
  }

  function resetColWidth(key) {
    const c = curCols().filter(x => x.key === key)[0];
    if (!c || !c.userWidth) return false;
    delete c.userWidth;
    commitWidths();
    return true;
  }

  let currentRows = [];

  function renderTable(page) {
    fitColumns();
    applyColgroup();

    /* 第一行：表头；第二行：列筛选控件 */
    const actTh = editMode() ? '<th class="col-actions" title="行操作">操作</th>' : '';
    els.tableHead.innerHTML =
      '<tr class="head-row"><th class="col-no">NO.</th>' +
        page.columns.map(function (c) {
          /* 列名单独包一层（截断用），再挂一条列宽拖拽把手 */
          const tip = c.userWidth
            ? c.label + '（列宽已手动设为 ' + c.userWidth + 'px，双击右侧边框恢复自动）'
            : c.label;
          return '<th style="min-width:' + (c.width || '120px') + '">' +
            '<span class="th-label" title="' + escapeAttr(tip) + '">' + escapeHtml(c.label) + '</span>' +
            '<span class="col-resize" data-col="' + escapeAttr(c.key) + '" ' +
              'title="拖动调整「' + escapeAttr(c.label) + '」列宽，双击恢复自动"></span>' +
          '</th>';
        }).join('') + actTh +
      '</tr>' +
      '<tr class="filter-row"><th class="col-no"></th>' +
        page.columns.map(function (c) {
          return '<th>' + filterControl(page, c) + '</th>';
        }).join('') + (editMode() ? '<th class="col-actions"></th>' : '') +
      '</tr>';

    currentRows = buildRows(page);

    const vendors = uniqueOf(page, guessVendorKey(page));
    const cats = uniqueOf(page, page.filterKey).filter(function (v) { return v !== PLACEHOLDER; });
    els.stats.innerHTML =
      statCard('记录总数', page.rows.length, '条', '') +
      statCard(page.filterLabel, cats.length, '类', '') +
      statCard('供应商 / 构成', vendors.length, '家', '') +
      statCard('字段数', page.columns.length + 1, '列', '');
  }

  /* 表头第二行的筛选控件 */
  function filterControl(page, c) {
    if (c.filter === 'select') {
      const opts = (c.options && c.options.length)
        ? c.options
        : uniqueOf(page, c.key).filter(function (v) { return v !== PLACEHOLDER; });
      return '<select class="col-filter" data-col="' + escapeAttr(c.key) + '" title="按' + escapeAttr(c.label) + '筛选">' +
        '<option value="' + ALL + '">全部</option>' +
        opts.map(function (o) {
          return '<option value="' + escapeAttr(o) + '">' + escapeHtml(o) + '</option>';
        }).join('') + '</select>';
    }
    if (c.filter === 'text') {
      return '<input class="col-filter" type="text" data-col="' + escapeAttr(c.key) + '" ' +
        'placeholder="筛选" title="按' + escapeAttr(c.label) + '筛选" autocomplete="off">';
    }
    return '';
  }

  function guessVendorKey(page) {
    const keys = page.columns.map(function (c) { return c.key; });
    return keys.indexOf('vendor') > -1 ? 'vendor' : page.filterKey;
  }

  function uniqueOf(page, key) {
    const set = {};
    page.rows.forEach(function (r) {
      if (r[key]) set[r[key]] = 1;
    });
    return Object.keys(set);
  }

  function statCard(label, value, unit, sub) {
    return '<div class="stat"><div class="stat-label">' + escapeHtml(label) + '</div>' +
      '<div class="stat-value">' + value + '<span class="unit">' + unit + '</span></div>' +
      (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</div>';
  }

  /* ---------------- 重点信息卡片（跨库聚焦） ---------------- */
  function renderFocusCard(page, focus) {
    if (!focus) {
      els.focusCard.hidden = true;
      els.focusCard.innerHTML = '';
      return;
    }
    const modelKey = page.modelKey || 'model';
    let found = null;
    page.rows.forEach(function (r) { if (r[modelKey] === focus) found = r; });

    const head =
      '<div class="fc-head">' +
        '<span class="fc-tag">重点信息</span>' +
        '<b>' + escapeHtml(focus) + '</b>' +
        '<span class="fc-from">来自 ' + escapeHtml(page.name) + '</span>' +
        '<a class="fc-close" href="#/' + currentPageId + '">清除聚焦</a>' +
      '</div>';

    if (!found) {
      els.focusCard.hidden = false;
      els.focusCard.innerHTML = head +
        '<div class="fc-empty">「' + escapeHtml(page.name) + '」中暂无型号为 ' + escapeHtml(focus) +
        ' 的记录，可在 data.js 对应数组中补充该型号。</div>';
      return;
    }

    const items = page.columns.map(function (c) {
      const v = (found[c.key] == null || found[c.key] === '') ? PLACEHOLDER : found[c.key];
      return '<div class="fc-item"><span class="fc-k">' + escapeHtml(c.label) + '</span>' +
        '<span class="fc-v' + (v === PLACEHOLDER ? ' ph' : '') + '">' + escapeHtml(v) + '</span></div>';
    }).join('');

    els.focusCard.hidden = false;
    els.focusCard.innerHTML = head + '<div class="fc-grid">' + items + '</div>';
  }

  /* ---------------- 筛选与渲染 ---------------- */
  function filteredList() {
    const page = currentPage();
    if (!page || !page.columns) return [];
    const kw = els.search.value.trim().toLowerCase();
    const modelKey = page.modelKey || null;

    return currentRows.filter(function (r) {
      /* 跨库聚焦：只保留被点击的型号 */
      if (currentFocus && modelKey && r[modelKey] !== currentFocus) return false;

      /* 表头筛选行（工具栏的下拉与筛选行同列联动，也走这里） */
      for (let i = 0; i < page.columns.length; i++) {
        const c = page.columns[i];
        const v = filters[c.key];
        if (!v || v === ALL) continue;
        const cell = String(r[c.key] == null ? '' : r[c.key]);
        if (c.filter === 'text') {
          /* 文本列：忽略大小写的模糊匹配 */
          if (cell.toLowerCase().indexOf(String(v).toLowerCase()) < 0) return false;
        } else {
          /* 下拉列：精确匹配 */
          if (cell !== String(v)) return false;
        }
      }

      /* 顶部关键字搜索：任意列匹配 */
      if (!kw) return true;
      return page.columns.some(function (c) {
        return String(r[c.key] || '').toLowerCase().indexOf(kw) > -1;
      });
    });
  }

  function drawRows() {
    const page = currentPage();
    if (!page || !page.columns) return;   /* 非数据页（如文件库）不绘制表格 */
    const modelKey = page.modelKey || null;
    const list = filteredList();

    els.tableBody.innerHTML = list.map(function (r, i) {
      const isEmpty = page.columns.every(function (c) { return r[c.key] === PLACEHOLDER; });
      const isFocusRow = !!(currentFocus && modelKey && r[modelKey] === currentFocus);
      /* 该行在 currentRows 中的序号，编辑时用于反查数据行 */
      const srcIdx = currentRows.indexOf(r);

      const cells = page.columns.map(function (c) {
        const raw = r[c.key];
        const v = (raw === '' || raw == null) ? PLACEHOLDER : raw;
        /* Sensor / Lens / VCM 为型号列，渲染成跳转链接 */
        if (v !== PLACEHOLDER && c.link && pageMap[c.link]) {
          return '<td class="linked" data-col="' + escapeAttr(c.key) + '" title="点击查看 ' + escapeAttr(v) + ' 重点信息">' +
            '<a class="cell-link" href="#/' + c.link + '/focus/' + encodeURIComponent(v) + '">' +
            escapeHtml(v) + '</a>' +
            (editMode() ? '<button class="cell-edit" title="编辑此单元格">✎</button>' : '') + '</td>';
        }
        const isNote = (c.key === 'note' || c.key === 'remark');
        const chips = (isNote && window.ISYS_Files) ? window.ISYS_Files.renderNoteChips(currentPageId, srcIdx) : '';
        return '<td' + (v === PLACEHOLDER ? ' class="ph"' : '') + ' data-col="' + escapeAttr(c.key) + '" title="' +
          escapeAttr(v) + '">' + escapeHtml(v) + (chips ? '<div class="note-attach-inline">' + chips + '</div>' : '') + '</td>';
      }).join('');

      /* 占位行（srcIdx >= 真实行数）没有排序意义，只给删除按钮 */
      const isRealRow = srcIdx < page.rows.length;
      const actTd = editMode()
        ? '<td class="row-actions">' +
            (isRealRow
              ? '<button class="row-drag" data-idx="' + srcIdx + '" draggable="true" ' +
                  'title="按住拖动可调整该行位置">⠿</button>' +
                '<button class="row-mv" data-idx="' + srcIdx + '" data-d="-1" title="上移一行">↑</button>' +
                '<button class="row-mv" data-idx="' + srcIdx + '" data-d="1" title="下移一行">↓</button>'
              : '<span class="row-ph" title="占位行无需排序">·</span>') +
            '<button class="row-del" data-idx="' + srcIdx + '" title="删除本行">✕</button>' +
          '</td>'
        : '';

      return '<tr class="' + (isEmpty ? 'is-placeholder' : '') + (isFocusRow ? ' row-focus' : '') +
               '" data-idx="' + srcIdx + '">' +
        '<td class="col-no">' + (i + 1) + '</td>' + cells + actTd + '</tr>';
    }).join('');

    /* 数据可能刚被编辑过，列宽要跟着内容重算（内部有脏标记，未变则跳过） */
    fitColumns();
    applyColgroup();

    const real = list.filter(function (r) {
      return !page.columns.every(function (c) { return r[c.key] === PLACEHOLDER; });
    }).length;
    els.rowCount.textContent = '共 ' + list.length + ' 行（有效 ' + real + ' 条）';
    els.emptyState.hidden = list.length > 0;
    els.table.style.display = list.length ? '' : 'none';

    /* 聚焦行滚动到可视区 */
    if (currentFocus) {
      const tr = els.tableBody.querySelector('tr.row-focus');
      if (tr && typeof tr.scrollIntoView === 'function') {
        try { tr.scrollIntoView({ block: 'center' }); } catch (e) { /* 老浏览器忽略 */ }
      }
    }
  }

  function resetToolbar(page) {
    filters = {};
    els.search.value = '';
    els.filterLabel.textContent = page.filterLabel;
    const opts = (page.filterOptions && page.filterOptions.length)
      ? page.filterOptions
      : uniqueOf(page, page.filterKey).filter(function (v) { return v !== PLACEHOLDER; });
    els.filter.innerHTML = '<option value="' + ALL + '">全部' + escapeHtml(page.filterLabel) + '</option>' +
      opts.map(function (o) {
        return '<option value="' + escapeAttr(o) + '">' + escapeHtml(o) + '</option>';
      }).join('');
    els.filter.value = ALL;

    els.tableHead.querySelectorAll('.col-filter').forEach(function (el) {
      if (el.tagName === 'SELECT') el.value = ALL; else el.value = '';
    });
  }

  /* 表格区高度自适应（表头吸顶依赖表格容器自身滚动） */
  function fitTableHeight() {
    if (!els.tableWrap || typeof els.tableWrap.getBoundingClientRect !== 'function') return;
    const top = els.tableWrap.getBoundingClientRect().top;
    if (!top) return;                       // 布局未就绪（如无渲染环境）时跳过
    const h = Math.max(200, window.innerHeight - top - 78);
    els.tableWrap.style.maxHeight = h + 'px';
  }

  function currentPage() {
    const entry = pageMap[currentPageId];
    return entry ? entry.page : null;   /* 文件库页（__files__）不在 pageMap 中，返回 null */
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  /* ---------------- CSV 导出 ---------------- */
  function exportCsv() {
    const page = currentPage();
    if (!page || !page.columns) return;
    const list = filteredList().filter(function (r) {
      return !page.columns.every(function (c) { return r[c.key] === PLACEHOLDER; });
    });

    const head = ['NO.'].concat(page.columns.map(function (c) { return c.label; }));
    const lines = [head.join(',')];
    list.forEach(function (r, i) {
      const line = [i + 1].concat(page.columns.map(function (c) {
        return r[c.key] === PLACEHOLDER ? '' : (r[c.key] || '');
      }));
      lines.push(line.map(csvCell).join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = page.name + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------------- 数据校验（枚举越界提醒，仅控制台告警，不阻断渲染） ----------------
   * data.js 是唯一的数据维护入口，若手填了枚举外的值，打开页面时会在控制台提示。
   * 二值列（是否为标品 / 是否在应用中）允许留空，填写时仅限 是 / 否。
   * ------------------------------------------------------------------------------ */
  function validateData() {
    const issues = [];
    LIBRARIES.forEach(function (lib) {
      (lib.children || [lib]).forEach(function (page) {
        page.columns.forEach(function (c) {
          if (!c.options || !c.options.length) return;
          /* 允许空值：新增列默认留空，填了才校验 */
          page.rows.forEach(function (r, i) {
            const v = r[c.key];
            if (v === undefined || v === null || v === '') return;
            if (c.options.indexOf(v) < 0) {
              issues.push(page.name + ' 第' + (i + 1) + '行「' + c.label + '」= “' + v +
                '” 不在可选项内（' + c.options.join(' / ') + '）');
            }
          });
        });
      });
    });
    if (issues.length && typeof console !== 'undefined' && console.warn) {
      console.warn('[ISYS 知识库] 数据校验发现 ' + issues.length + ' 处取值越界：\n' + issues.join('\n'));
    }
    return issues;
  }

  /* ---------------- 事件绑定 ---------------- */
  els.tree.addEventListener('click', function (e) {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      expanded[id] = !expanded[id];
      renderTree();
      highlightActive();
      return;
    }
    const link = e.target.closest('[data-page]');
    if (link) {
      e.preventDefault();
      location.hash = '#/' + link.dataset.page;
    }
  });

  els.overview.addEventListener('click', function (e) {
    const card = e.target.closest('.ov-card');
    if (card) {
      e.preventDefault();
      location.hash = card.getAttribute('href');
    }
  });

  /* 表头筛选行：input / change 都触发重绘 */
  function onColFilter(e) {
    const el = e.target.closest('.col-filter');
    if (!el) return;
    const key = el.dataset.col;
    filters[key] = el.value;
    /* 与顶部工具栏下拉双向同步 */
    if (key === currentPage().filterKey && els.filter) els.filter.value = el.value || ALL;
    drawRows();
  }
  els.tableHead.addEventListener('input', onColFilter);
  els.tableHead.addEventListener('change', onColFilter);

  /* 列宽拖拽：把手在表头内，用委托绑定，重绘后无需重新绑；move/up 绑在 document 上，
     这样鼠标拖出表头范围（甚至拖到窗口外）也不会中断。 */
  els.tableHead.addEventListener('mousedown', onResizeStart);
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  els.tableHead.addEventListener('dblclick', function (e) {
    const h = (e.target && e.target.closest) ? e.target.closest('.col-resize') : null;
    if (!h) return;
    e.preventDefault();
    resetColWidth(h.dataset.col);
  });

  els.search.addEventListener('input', drawRows);
  els.clearSearch.addEventListener('click', function () {
    els.search.value = '';
    drawRows();
    els.search.focus();
  });

  /* 顶部工具栏下拉 → 写入 filters，并同步筛选行同列控件 */
  els.filter.addEventListener('change', function () {
    const key = currentPage().filterKey;
    filters[key] = els.filter.value;
    const sel = els.tableHead.querySelector('select.col-filter[data-col="' + key + '"]');
    if (sel) sel.value = els.filter.value;
    drawRows();
  });

  els.exportBtn.addEventListener('click', exportCsv);

  els.sideToggle.addEventListener('click', function () {
    els.sidebar.classList.toggle('collapsed');
  });

  els.collapseAll.addEventListener('click', function () {
    const nav = window.ISYS_NAV || { groups: [] };
    const groups = nav.groups || [];
    const anyOpen = groups.some(function (l) { return expanded[l.id]; });
    groups.forEach(function (l) { expanded[l.id] = !anyOpen; });
    renderTree();
    highlightActive();
    els.collapseAll.textContent = anyOpen ? '展开' : '收起';
  });

  window.addEventListener('hashchange', function () {
    const p = parseHash();
    renderPage(p.id, p.focus);
  });

  /* 窗口尺寸变化：容器宽度变了，列宽要按比例重算（debounce 一下，避免拖窗口时卡） */
  let resizeTimer = null;
  window.addEventListener('resize', function () {
    fitTableHeight();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!els.dataSection || els.dataSection.hidden) return;
      fitColumns(true);
      applyColgroup();
    }, 120);
  });

  /* 字体加载完成会改变文字宽度，加载完成后强制重算一次 */
  window.addEventListener('load', function () {
    if (els.dataSection && !els.dataSection.hidden) { fitColumns(true); applyColgroup(); }
  });

  /* ---------------- 启动：渲染整个应用 ---------------- */
  function bootApp() {
    buildIndex();   // 始终基于当前 LIBRARIES 重建索引（云端热替换后也走这里）
    const nav = window.ISYS_NAV || { groups: [], fileRoots: [] };
    const topCount = (nav.groups ? nav.groups.length : 0) + (nav.fileRoots ? nav.fileRoots.length : 0);
    document.getElementById('libCount').textContent = topCount;
    document.getElementById('pageCount').textContent =
      Object.keys(pageMap).length + (nav.fileRoots ? nav.fileRoots.length : 0);
  if (els.topDate) els.topDate.textContent = '更新：' + LIB_META.updated;

  /* ---------------- 对外接口（供 editor.js 调用） ----------------
   * 只暴露必要的读写与重绘能力，避免 editor.js 直接改内部状态。
   * --------------------------------------------------------------- */
  window.ISYS = {
    page: currentPage,
    pageId: function () { return currentPageId; },

    /* 全部叶子页：[{ id, page, parent }] */
    pages: function () {
      const out = [];
      LIBRARIES.forEach(function (l) {
        (l.children || [l]).forEach(function (p) { out.push({ id: p.id, page: p, parent: l }); });
      });
      return out;
    },

    /* 与指定页共用同一份列定义的所有页（模组三库始终同步） */
    groupOf: function (pageId) {
      const all = window.ISYS.pages();
      const self = all.filter(function (x) { return x.id === pageId; })[0];
      if (!self) return [];
      return all.filter(function (x) { return x.page.columns === self.page.columns; });
    },

    /* 取真实数据行（不是渲染副本），编辑器直接改这个数组 */
    rowsOf: function (pageId) {
      const p = pageMap[pageId];
      return p ? p.page.rows : [];
    },
    colsOf: function (pageId) {
      const p = pageMap[pageId];
      return p ? p.page.columns : [];
    },

    /* 行数据变化后：保留表头与筛选条件，只重算数据并重绘 */
    syncRows: function () {
      markFitDirty();
      currentRows = buildRows(currentPage());
      drawRows();
    },

    /* 列结构变化后：重建表头，并恢复此前的筛选条件 */
    rebuild: function () {
      const keep = filters, kw = els.search.value;
      markFitDirty();
      /* 当前页是一级目录（如 #/module）时没有表格，直接整页重渲染 */
      const cur = currentPage();
      if (!cur || !cur.columns) { renderPage(currentPageId, currentFocus); return; }
      renderTable(cur);
      els.tableHead.querySelectorAll('.col-filter').forEach(function (el) {
        const k = el.dataset.col;
        if (keep[k] != null) el.value = keep[k];
      });
      els.search.value = kw;
      filters = keep;
      drawRows();
    },

    /* 整页重渲染（切库、数据大改时用） */
    rerender: function () { renderPage(currentPageId, currentFocus); },
    /* 云端热替换 LIBRARIES 后重建 pageMap 索引 */
    reindex: function () { buildIndex(); },
    /* 左侧树重渲染（行数变化后刷新计数） */
    refreshTree: function () { renderTree(); highlightActive(); },
    /* 列宽自适应：内容/列结构变化后重算（force=true 无条件重算） */
    fitColumns: function (force) { fitColumns(!!force); applyColgroup(); },
    /* 列宽拖拽：手动定宽 / 恢复自动（供脚本与测试调用） */
    setColWidth: setColWidth,
    resetColWidth: resetColWidth,
    colWidths: function () { return fitWidths.slice(); },
    escapeHtml: escapeHtml,
    editMode: editMode
  };

    validateData();
    renderTree();
    const init = parseHash();
    renderPage(init.id, init.focus);
  }

  /* ---------------- 入口：先本地渲染，再异步从云端同步 ---------------- */
  bootApp();
  if (window.ISYS_Sync && window.ISYS_Sync.enabled()) {
    window.ISYS_Sync.bootstrap();
  }
})();
