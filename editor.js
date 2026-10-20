/* ============================================================
 * ISYS 器件开发知识库 —— 编辑模式（需口令解锁）
 * 依赖：data.js → app.js → auth.js → editor.js
 * ============================================================
 * 只读状态下本文件不做任何 DOM 干预，页面行为与之前完全一致。
 * 解锁后才启用：单元格编辑 / 增删行 / 移动行 / 增删列 / 本地缓存 / 导出 data.js
 * ============================================================ */

(function () {
  'use strict';

  const A = window.ISYS_Auth;
  const M = window.ISYS_Modal;
  const esc = M.esc;
  const PLACEHOLDER = '—';

  const STORE = 'isys_kb_data';   // 本地缓存键

  let active = false;      // 编辑模式开关
  let groups = [];         // 列定义分组：[{ key, ids }]
  let sig = { rows: {}, cols: {} };   // data.js 原始内容指纹，用于识别 data.js 是否被人手改过
  let lastAction = '编辑更新';          // 最近一次操作的标签（用于同步提交信息）

  /* ---------------- 本地存储（localStorage 不可用时退回内存） ---------------- */
  const mem = {};
  function lg(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return mem[k] == null ? null : mem[k]; }
  }
  function ls(k, v) {
    mem[k] = String(v);
    try { window.localStorage.setItem(k, String(v)); } catch (e) { /* 配额/隐私模式，忽略 */ }
  }
  function ld(k) {
    try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
    delete mem[k];
  }

  /* ---------------- 工具 ---------------- */
  const hash = s => A.sha256(JSON.stringify(s));
  const tbody = () => document.getElementById('tableBody');
  const curId = () => window.ISYS.pageId();
  const curRows = () => window.ISYS.rowsOf(curId());
  const curCols = () => window.ISYS.colsOf(curId());
  const colByKey = k => curCols().filter(c => c.key === k)[0];

  /* ---------------- 分组：共用同一份列定义的页面（模组三库同步） ---------------- */
  function buildGroups() {
    const seen = {};
    const out = [];
    window.ISYS.pages().forEach(p => {
      if (seen[p.id]) return;
      const ids = window.ISYS.groupOf(p.id).map(x => x.id);
      ids.forEach(id => { seen[id] = 1; });
      out.push({ key: ids[0], ids: ids });
    });
    return out;
  }
  const groupKeyOf = pid => (groups.filter(g => g.ids.indexOf(pid) > -1)[0] || {}).key || pid;

  /* ---------------- 读取 / 写入本地缓存 ---------------- */
  function loadStore() {
    try { return JSON.parse(lg(STORE) || '{}'); } catch (e) { return {}; }
  }

  /* 把本地缓存套用到内存数据上。若 data.js 已被人手修改（指纹不符），则丢弃缓存，以 data.js 为准 */
  function applySaved() {
    groups = buildGroups();
    window.ISYS.pages().forEach(p => { sig.rows[p.id] = hash(p.page.rows); });
    groups.forEach(g => { sig.cols[g.key] = hash(window.ISYS.colsOf(g.ids[0])); });

    const s = loadStore();
    if (!s || !s.sig) return;
    let dropped = 0;

    window.ISYS.pages().forEach(p => {
      const savedSig = s.sig.rows && s.sig.rows[p.id];
      if (savedSig && savedSig === sig.rows[p.id] && s.rows && s.rows[p.id]) {
        p.page.rows = s.rows[p.id];
      } else if (s.rows && s.rows[p.id]) {
        dropped++;
      }
    });

    groups.forEach(g => {
      const savedSig = s.sig.cols && s.sig.cols[g.key];
      if (savedSig && savedSig === sig.cols[g.key] && s.cols && s.cols[g.key]) {
        g.ids.forEach(id => { pageObj(id).columns = s.cols[g.key]; });
      } else if (s.cols && s.cols[g.key]) {
        dropped++;
      }
    });

    if (dropped) {
      setTimeout(function () {
        M.toast('检测到 data.js 已被修改，' + dropped + ' 处本地缓存已失效并以 data.js 为准');
      }, 400);
    }
  }

  function pageObj(id) {
    return window.ISYS.pages().filter(x => x.id === id)[0].page;
  }

  function persist() {
    const s = { v: 1, rows: {}, cols: {}, sig: { rows: sig.rows, cols: sig.cols }, updated: new Date().toISOString() };
    window.ISYS.pages().forEach(p => {
      if (hash(p.page.rows) !== sig.rows[p.id]) s.rows[p.id] = p.page.rows;
    });
    groups.forEach(g => {
      if (hash(window.ISYS.colsOf(g.ids[0])) !== sig.cols[g.key]) s.cols[g.key] = window.ISYS.colsOf(g.ids[0]);
    });
    ls(STORE, JSON.stringify(s));   // 本地缓存保留，作为离线兜底
    updateStatus();
    /* 云端态：编辑后自动同步到共享仓库 */
    if (window.ISYS_Sync && window.ISYS_Sync.enabled()) {
      window.ISYS_Sync.schedulePush(lastAction);
    }
  }

  /* 未导回 data.js 的改动处数 */
  function changedCount() {
    let n = 0;
    window.ISYS.pages().forEach(p => { if (hash(p.page.rows) !== sig.rows[p.id]) n++; });
    groups.forEach(g => { if (hash(window.ISYS.colsOf(g.ids[0])) !== sig.cols[g.key]) n++; });
    return n;
  }

  /* ============================================================
   * 操作历史（撤销 / 重做）
   *   past    已执行的操作，每项存该操作「执行前」的快照，最多 HIST_MAX 条
   *   future  已撤销的操作，每项存该操作「执行后」的快照，最多 HIST_MAX 条
   *   快照只含数据本身（各页 rows + 各列分组 columns），不含筛选、滚动等界面状态。
   *   只有真的数据变了才入栈：可能落空的改动用 beginOp / endOp / cancelOp 包起来。
   * ============================================================ */
  const HIST_MAX = 5;

  let past = [];       // [{ label, snap }]
  let future = [];     // [{ label, snap }]
  let pending = null;  // 已拍照、但改动还没确认的操作
  let histOpen = false;

  /* 拍下当前全部数据：行按页存，列按分组存（模组三库共用同一份列定义） */
  function snapshot() {
    const s = { cols: {}, rows: {} };
    groups.forEach(function (g) {
      s.cols[g.key] = JSON.parse(JSON.stringify(window.ISYS.colsOf(g.ids[0])));
    });
    window.ISYS.pages().forEach(function (p) {
      s.rows[p.id] = JSON.parse(JSON.stringify(p.page.rows));
    });
    return s;
  }

  /* 还原快照。列仍按分组共用同一个数组对象，保证三库结构始终一致 */
  function restore(s) {
    groups.forEach(function (g) {
      if (!s.cols[g.key]) return;
      const cols = JSON.parse(JSON.stringify(s.cols[g.key]));
      g.ids.forEach(function (id) { pageObj(id).columns = cols; });
    });
    window.ISYS.pages().forEach(function (p) {
      const src = s.rows[p.id];
      if (!src) return;
      const rows = window.ISYS.rowsOf(p.id);
      rows.length = 0;
      src.forEach(function (r) { rows.push(JSON.parse(JSON.stringify(r))); });
    });
  }

  /* 改动「之前」调 beginOp 拍照；确认改动真的生效后调 endOp 入栈 */
  function beginOp(label) {
    pending = { label: label, snap: snapshot() };
  }

  function endOp() {
    if (!pending) return;
    lastAction = pending.label || lastAction;
    past.push({ label: pending.label, snap: pending.snap });
    while (past.length > HIST_MAX) past.shift();   /* 只留最近 HIST_MAX 步 */
    future.length = 0;                             /* 有新操作，重做栈失效 */
    pending = null;
    renderHistory();
  }

  /* 改动落空（例如移动后位置没变）：丢弃这次拍照，历史保持不变 */
  function cancelOp() { pending = null; }

  /* 一定会产生变化的简单入口：拍照并立即入栈 */
  function record(label) { beginOp(label); endOp(); }

  function pushFuture(e) {
    future.push(e);
    while (future.length > HIST_MAX) future.shift();  /* 只留离当前最近的 HIST_MAX 步 */
  }

  function undo(quiet) {
    if (!past.length) { if (!quiet) M.toast('没有可撤销的操作'); return false; }
    const e = past.pop();
    pushFuture({ label: e.label, snap: snapshot() });   /* 撤销前的状态留着供重做 */
    restore(e.snap);
    afterHistory();
    if (!quiet) M.toast('已撤销：' + e.label);
    return true;
  }

  function redo(quiet) {
    if (!future.length) { if (!quiet) M.toast('没有可重做的操作'); return false; }
    const e = future.pop();
    past.push({ label: e.label, snap: snapshot() });   /* 重做前的状态留着供再撤销 */
    while (past.length > HIST_MAX) past.shift();
    restore(e.snap);
    afterHistory();
    if (!quiet) M.toast('已重做：' + e.label);
    return true;
  }

  /* 一次跳多步：n < 0 撤销 |n| 步，n > 0 重做 n 步 */
  function jump(n) {
    let k = 0;
    if (n < 0) {
      k = Math.min(-n, past.length);
      for (let i = 0; i < k; i++) undo(true);
      if (k) M.toast('已一次撤销 ' + k + ' 步');
    } else {
      k = Math.min(n, future.length);
      for (let i = 0; i < k; i++) redo(true);
      if (k) M.toast('已一次重做 ' + k + ' 步');
    }
    histOpen = false;
    renderHistory();
    return k;
  }

  /* 撤销 / 重做落地：写本地缓存、重画表格、刷新左侧计数与状态条 */
  function afterHistory() {
    persist();
    window.ISYS.refreshTree();
    window.ISYS.rebuild();
    updateStatus();
    renderHistory();
  }

  /* ---------------- 操作历史界面 ---------------- */
  function shortVal(v, n) {
    /* 框内的换行压成一个 ↵，保证操作历史里的条目始终是一行 */
    const s = String(v == null ? '' : v).replace(/\r?\n/g, '\u21b5');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function histListHtml() {
    /* 列表都按「离当前最近」排最前：已执行的最新在前，可重做的最近一次在前 */
    const done = past.slice().reverse();
    const undone = future.slice().reverse();

    function sec(title, arr, cls, empty) {
      const body = arr.length
        ? arr.map(function (e, i) {
            return '<button class="hist-item ' + cls + '" data-step="' + (i + 1) + '">' +
              '<span class="hist-n">' + (i + 1) + '</span>' +
              '<span class="hist-t">' + esc(e.label) + '</span>' +
              '<span class="hist-go">' + (cls === 'past' ? '回到此前' : '前进到此') + '</span>' +
            '</button>';
          }).join('')
        : '<div class="hist-empty">' + empty + '</div>';
      return '<div class="hist-sec">' +
        '<div class="hist-hd">' + title + '<span class="hist-cnt">' + arr.length + '/' + HIST_MAX + '</span></div>' +
        body + '</div>';
    }

    return sec('已执行', done, 'past', '还没有可撤销的操作') +
      sec('已撤销（可重做）', undone, 'future', '没有可重做的操作') +
      '<div class="hist-foot">前后各保留最近 ' + HIST_MAX + ' 步 · 点击任一条可一次跳到该步</div>';
  }

  function renderHistory() {
    const zone = document.getElementById('histZone');
    if (!zone) return;
    if (!active) { zone.hidden = true; zone.innerHTML = ''; return; }
    zone.hidden = false;

    const uLabel = past.length ? past[past.length - 1].label : '没有可撤销的操作';
    const rLabel = future.length ? future[future.length - 1].label : '没有可重做的操作';

    zone.innerHTML =
      '<button class="hbtn" id="hUndo"' + (past.length ? '' : ' disabled') +
        ' title="撤销：' + esc(uLabel) + '（Ctrl+Z）">↶ 撤销</button>' +
      '<button class="hbtn" id="hRedo"' + (future.length ? '' : ' disabled') +
        ' title="重做：' + esc(rLabel) + '（Ctrl+Y）">↷ 重做</button>' +
      '<button class="hbtn hbtn-list" id="hList" title="展开 / 收起操作记录">' +
        '操作记录<span class="hnum">' + past.length + '/' + future.length + '</span></button>' +
      '<div class="hist-pop" id="histPop"' + (histOpen ? '' : ' hidden') + '>' + histListHtml() + '</div>';

    const u = document.getElementById('hUndo');
    if (u) u.addEventListener('click', function () { undo(); });
    const r = document.getElementById('hRedo');
    if (r) r.addEventListener('click', function () { redo(); });
    const l = document.getElementById('hList');
    if (l) l.addEventListener('click', function (e) {
      e.stopPropagation();
      histOpen = !histOpen;
      renderHistory();
    });

    /* 点击列表里的某一条：一次跳到那一步 */
    const pop = document.getElementById('histPop');
    if (pop) pop.addEventListener('click', function (e) {
      const it = (e.target && e.target.closest) ? e.target.closest('.hist-item') : null;
      if (!it) return;
      const n = parseInt(it.dataset.step, 10) || 1;
      jump(it.classList.contains('past') ? -n : n);
    });
  }

  /* 全局事件只绑一次：点面板外关闭 + Ctrl+Z / Ctrl+Y 快捷键 */
  function bindHistoryGlobal() {
    document.addEventListener('click', function (e) {
      if (!histOpen) return;
      const zone = document.getElementById('histZone');
      if (zone && e.target && zone.contains(e.target)) return;
      histOpen = false;
      renderHistory();
    });

    document.addEventListener('keydown', function (e) {
      if (!active) return;
      /* 正在编辑单元格时，Ctrl+Z 留给输入框自身的文本撤销 */
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    });
  }

  /* ---------------- 顶部权限区 ---------------- */
  function renderAuthZone() {
    const zone = document.getElementById('authZone');
    if (!zone) return;

    if (!A.isUnlocked()) {
      zone.innerHTML = '<button class="ebtn lock" id="btnUnlock" title="需口令开通">🔒 申请编辑权限</button>';
      document.getElementById('btnUnlock').addEventListener('click', openUnlock);
      return;
    }

    zone.innerHTML =
      '<span class="edit-flag" title="编辑模式：双击单元格即可修改">🔓 编辑模式</span>' +
      '<button class="ebtn primary" id="btnAddRow">＋ 新增行</button>' +
      '<button class="ebtn" id="btnCols">管理列</button>' +
      '<button class="ebtn" id="btnExportJs">导出 data.js</button>' +
      '<button class="ebtn" id="btnPwd">修改口令</button>' +
      '<button class="ebtn danger" id="btnLock">锁定</button>';

    document.getElementById('btnAddRow').addEventListener('click', addRow);
    document.getElementById('btnCols').addEventListener('click', openColMgr);
    document.getElementById('btnExportJs').addEventListener('click', exportDataJs);
    document.getElementById('btnPwd').addEventListener('click', openPwd);
    document.getElementById('btnLock').addEventListener('click', function () {
      A.lock();
      M.toast('已锁定，回到只读模式');
    });
  }

  /* ---------------- 底部状态条 ---------------- */
  function updateStatus() {
    const foot = document.querySelector('.table-foot');
    if (!foot) return;
    let box = document.getElementById('saveStatus');

    if (!active) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('span');
      box.id = 'saveStatus';
      box.className = 'save-status';
      foot.insertBefore(box, foot.firstChild);
    }
    const n = changedCount();
    box.innerHTML =
      '<span class="dot-saved"></span>' +
      (n ? '本地已保存 · <b>' + n + '</b> 处改动未导回 data.js' : '本地已保存 · 与 data.js 一致') +
      '<button class="link-btn" id="btnReset">重置为初始数据</button>';
    document.getElementById('btnReset').addEventListener('click', resetAll);
  }

  /* ---------------- 解锁弹窗 ---------------- */
  function openUnlock() {
    const left = A.remainingBlock();
    M.open({
      title: '编辑权限申请',
      desc: left
        ? '尝试次数过多，请 ' + Math.ceil(left / 1000) + ' 秒后再试'
        : '本页编辑需管理员开通权限，请输入口令',
      width: '420px',
      bodyHtml:
        '<label class="fm-label">编辑口令</label>' +
        '<input type="password" id="pwdInput" class="fm-input" placeholder="请输入口令" autocomplete="off">' +
        '<div class="fm-err" id="pwdErr"></div>' +
        '<div class="fm-tip">口令请联系知识库管理员（ISYS 器件组）获取。<br>' +
        '连续错误 ' + A.config.MAX_FAILS + ' 次将临时锁定 ' + (A.config.BLOCK_MS / 1000) + ' 秒。</div>',
      buttons: [
        { text: '取消', cls: 'ghost-btn', close: true },
        {
          text: '开通权限', cls: 'primary-btn', close: false,
          onClick: function (root, close) {
            const v = root.querySelector('#pwdInput').value;
            const r = A.unlock(v);
            if (r.ok) { close(); M.toast(r.msg); }
            else {
              const e = root.querySelector('#pwdErr');
              if (e) e.textContent = r.msg;
              const inp = root.querySelector('#pwdInput');
              if (inp) { inp.value = ''; inp.focus(); inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 400); }
            }
          }
        }
      ]
    });
  }

  /* ---------------- 修改口令 ---------------- */
  function openPwd() {
    M.open({
      title: '修改编辑口令',
      desc: '新口令仅在当前浏览器生效；要永久生效请改 auth.js 后重新分发',
      width: '420px',
      bodyHtml:
        '<label class="fm-label">当前口令</label><input type="password" id="pwOld" class="fm-input">' +
        '<label class="fm-label">新口令（至少 4 位）</label><input type="password" id="pwNew" class="fm-input">' +
        '<label class="fm-label">确认新口令</label><input type="password" id="pwNew2" class="fm-input">' +
        '<div class="fm-err" id="pwErr"></div>',
      buttons: [
        { text: '恢复内置口令', cls: 'ghost-btn', close: false, onClick: function (root, close) { A.resetPassword(); close(); M.toast('已恢复为内置口令'); } },
        { text: '取消', cls: 'ghost-btn', close: true },
        {
          text: '保存', cls: 'primary-btn', close: false,
          onClick: function (root, close) {
            const r = A.changePassword(
              root.querySelector('#pwOld').value,
              root.querySelector('#pwNew').value,
              root.querySelector('#pwNew2').value
            );
            if (r.ok) { close(); M.toast(r.msg); }
            else { const e = root.querySelector('#pwErr'); if (e) e.textContent = r.msg; }
          }
        }
      ]
    });
  }

  /* ---------------- 单元格编辑 ---------------- */

  /* 多行输入框高度跟着内容走：最少 1 行，最多 8 行，再多就内部滚动 */
  const TA_MAX_ROWS = 8;
  function autoGrow(ta) {
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    /* 单位行高（line-height: 1.5）在个别环境只会返回 1.5 而不是像素值，兜一下 */
    const rawLh = parseFloat(window.getComputedStyle(ta).lineHeight) || 0;
    const lh = rawLh < 8 ? 18 : rawLh;
    const max = Math.round(lh * TA_MAX_ROWS) + 10;
    ta.style.height = 'auto';
    const need = (ta.scrollHeight || 0) + 2;   /* jsdom 无布局，scrollHeight 为 0，落到最小值 */
    const h = Math.min(max, Math.max(28, need));
    ta.style.height = h + 'px';
    ta.style.overflowY = (need > max) ? 'auto' : 'hidden';
  }

  /* 在光标处插入一个换行，并把光标移到换行之后（支持框内换行的核心） */
  function insertNewline(ctl) {
    if (!ctl || ctl.tagName !== 'TEXTAREA') return;
    const s = (ctl.selectionStart == null) ? ctl.value.length : ctl.selectionStart;
    const t = (ctl.selectionEnd == null) ? s : ctl.selectionEnd;
    ctl.value = ctl.value.slice(0, s) + '\n' + ctl.value.slice(t);
    const p = s + 1;
    try { ctl.setSelectionRange(p, p); } catch (err) { /* 老浏览器不支持就算了 */ }
    autoGrow(ctl);
  }

  function startEdit(trIdx, colKey) {
    if (!active) return;
    let idx = trIdx;

    /* 占位行：先转成正行再编辑 */
    if (idx >= curRows().length) {
      record('新增行（填写占位行）· ' + pageObj(curId()).name);
      curRows().push({});
      window.ISYS.syncRows();
      idx = curRows().length - 1;
      persist();
    }

    const tr = tbody().querySelector('tr[data-idx="' + idx + '"]');
    if (!tr) return;
    let td = null;
    Array.prototype.forEach.call(tr.children, function (c) {
      if (c.dataset && c.dataset.col === colKey) td = c;
    });
    if (!td || td.classList.contains('editing')) return;

    const col = colByKey(colKey);
    if (!col) return;
    const row = curRows()[idx];
    const old = (row[colKey] == null || row[colKey] === '') ? '' : String(row[colKey]);

    td.classList.add('editing');
    td.innerHTML = '';

    let ctl;
    if (col.options && col.options.length) {
      ctl = document.createElement('select');
      ctl.className = 'cell-input';
      ctl.innerHTML = '<option value="">（留空）</option>' + col.options.map(function (o) {
        return '<option value="' + esc(o) + '"' + (String(o) === old ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
    } else if (col.type === 'month' || col.key === 'devTime') {
      ctl = document.createElement('input');
      ctl.className = 'cell-input';
      ctl.type = 'month';
      ctl.value = old;
      ctl.placeholder = 'YYYY-MM';
    } else {
      /* 自由文本用 textarea：才能支持「框内换行」
         （Shift / Alt / Ctrl + Enter 换行，直接 Enter 仍是保存） */
      ctl = document.createElement('textarea');
      ctl.className = 'cell-input cell-input-multi';
      ctl.rows = 1;
      ctl.value = old;
      ctl.placeholder = 'Shift+Enter 换行';
    }
    td.appendChild(ctl);
    ctl.focus();
    /* 只有文本框才好全选（HTMLSelectElement 没有 select() 方法） */
    if (ctl.tagName === 'INPUT' || ctl.tagName === 'TEXTAREA') ctl.select();
    if (ctl.tagName === 'TEXTAREA') autoGrow(ctl);

    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      const val = save ? String(ctl.value) : null;
      td.classList.remove('editing');
      if (val === null) { window.ISYS.syncRows(); return; }
      if (!commit(idx, colKey, val)) { window.ISYS.syncRows(); startEdit(idx, colKey); }
    }

    ctl.addEventListener('keydown', function (e) {
      /* 框内换行：Shift / Alt / Ctrl / Cmd + Enter 都认，习惯哪个用哪个 */
      if (e.key === 'Enter' && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        insertNewline(ctl);
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true);
        const next = nextCol(colKey);
        if (next) startEdit(idx, next.key);
      }
    });
    ctl.addEventListener('input', function () { autoGrow(ctl); });
    ctl.addEventListener('blur', function () { finish(true); });
    if (ctl.tagName === 'SELECT') {
      ctl.addEventListener('change', function () { finish(true); });
    }
  }

  function commit(idx, colKey, val) {
    const col = colByKey(colKey);
    const row = curRows()[idx];
    if (!row) return true;

    /* 枚举列校验 */
    if (col.options && col.options.length && val && col.options.indexOf(val) < 0) {
      M.toast('「' + col.label + '」只能取：' + col.options.join(' / '));
      return false;
    }
    const old = row[colKey] || '';
    if (old === val) { window.ISYS.syncRows(); return true; }

    record('修改「' + col.label + '」第 ' + (idx + 1) + ' 行：' +
      (shortVal(old, 10) || '空') + ' → ' + (shortVal(val, 10) || '空'));
    row[colKey] = val;
    persist();
    window.ISYS.syncRows();
    return true;
  }

  function nextCol(key) {
    const cs = curCols();
    const i = cs.map(c => c.key).indexOf(key);
    return (i > -1 && i + 1 < cs.length) ? cs[i + 1] : null;
  }

  /* ---------------- 增删行 ---------------- */
  function addRow() {
    if (!active) return;
    record('新增行 · ' + pageObj(curId()).name);
    curRows().push({});
    persist();
    window.ISYS.syncRows();
    const wrap = document.querySelector('.table-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    M.toast('已新增 1 行，双击单元格填写' + (filterActive() ? '（当前有筛选条件，新行可能未显示）' : ''));
  }

  function delRow(idx) {
    if (!active) return;
    const rows = curRows();
    if (idx >= rows.length) { M.toast('占位行无需删除，直接双击填写即可'); return; }
    record('删除第 ' + (idx + 1) + ' 行 · ' + pageObj(curId()).name);
    rows.splice(idx, 1);
    persist();
    window.ISYS.syncRows();
    /* 撤销统一走操作历史，不再各自维护一份临时还原逻辑 */
    M.toast('已删除 1 行', { text: '撤销', onClick: function () { undo(); } });
  }

  /* ---------------- 移动行（排序） ----------------
   * from / target 都是「真实行数组 page.rows」的下标（即 tr 上的 data-idx）。
   * 有筛选时按「当前可见顺序」移动：参照的是相邻可见行，而不是相邻物理行。
   * ------------------------------------------------------------------- */

  /* 当前渲染出来的真实行下标，按显示顺序排列（占位行排除在外） */
  function visibleRealIdx() {
    const n = curRows().length;
    const out = [];
    const tb = tbody();
    if (!tb) return out;
    Array.prototype.forEach.call(tb.querySelectorAll('tr[data-idx]'), function (tr) {
      const i = parseInt(tr.dataset.idx, 10);
      if (!isNaN(i) && i < n) out.push(i);
    });
    return out;
  }

  /* ↑ / ↓ 一步移动：d = -1 上移，d = 1 下移 */
  function stepMove(idx, d) {
    if (!active) return false;
    const list = visibleRealIdx();
    const pos = list.indexOf(idx);
    if (pos < 0) return false;
    const nb = list[pos + d];
    if (nb === undefined) {
      M.toast(d < 0 ? '已经是可见范围的第一行' : '已经是可见范围的最后一行');
      return false;
    }
    return moveRowTo(idx, nb, d > 0);
  }

  /* 核心：把 from 移到 target 之前（after=false）或之后（after=true）。
   * target 越界（落在占位区）时，统一移到真实行末尾。 */
  function moveRowTo(from, target, after) {
    const rows = curRows();
    const n = rows.length;
    if (from < 0 || from >= n) return false;

    let to;
    if (target >= n || target < 0) {
      to = n - 1;                                       /* 占位区 → 真实行末尾 */
    } else if (after) {
      to = (target > from) ? target : target + 1;
    } else {
      to = (target > from) ? target - 1 : target;
    }
    /* 注意：to 是「移除 from 之后」的插入下标 */

    /* 落点在移除后会被夹到 [0, n-1]，先按同样规则算出来写进操作记录 */
    let toDisp = to;
    if (toDisp < 0) toDisp = 0;
    if (toDisp > n - 1) toDisp = n - 1;

    const before = JSON.stringify(rows);
    beginOp('移动行 · 第 ' + (from + 1) + ' 行 → 第 ' + (toDisp + 1) + ' 行');
    const moved = rows.splice(from, 1)[0];
    if (to < 0) to = 0;
    if (to > rows.length) to = rows.length;
    rows.splice(to, 0, moved);
    if (JSON.stringify(rows) === before) { cancelOp(); return false; }  /* 位置没变，不入历史、不重绘 */
    endOp();

    endDrag();
    persist();
    window.ISYS.syncRows();
    keepVisible(to);
    return true;
  }

  /* 移动后把该行滚回可视区（表格可横向 + 纵向滚动） */
  function keepVisible(idx) {
    const tb = tbody();
    if (!tb) return;
    const tr = tb.querySelector('tr[data-idx="' + idx + '"]');
    if (!tr || typeof tr.scrollIntoView !== 'function') return;
    try { tr.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
  }

  /* ---------------- 拖拽排序 ---------------- */
  let dragIdx = null;

  function clearDropMarks() {
    const tb = tbody();
    if (!tb) return;
    Array.prototype.forEach.call(tb.querySelectorAll('.drop-above, .drop-below'), function (el) {
      el.classList.remove('drop-above', 'drop-below');
    });
  }

  function endDrag() {
    dragIdx = null;
    clearDropMarks();
    const tb = tbody();
    if (!tb) return;
    Array.prototype.forEach.call(tb.querySelectorAll('.drag-src'), function (el) {
      el.classList.remove('drag-src');
    });
  }

  function rowOf(e) {
    return (e.target && e.target.closest) ? e.target.closest('tr[data-idx]') : null;
  }

  function onDragStart(e) {
    if (!active) return;
    const h = (e.target && e.target.closest) ? e.target.closest('.row-drag') : null;
    if (!h) return;
    dragIdx = parseInt(h.dataset.idx, 10);
    const tr = h.closest('tr');
    if (tr) tr.classList.add('drag-src');
    try {
      e.dataTransfer.setData('text/plain', String(dragIdx));
      e.dataTransfer.effectAllowed = 'move';
      if (tr) e.dataTransfer.setDragImage(tr, 12, 12);
    } catch (err) { /* 环境不支持 dataTransfer / setDragImage，忽略 */ }
  }

  function onDragOver(e) {
    if (dragIdx === null || !active) return;
    const tr = rowOf(e);
    if (!tr) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
    clearDropMarks();
    let after = false;
    try {
      const r = tr.getBoundingClientRect();
      after = (e.clientY - r.top) > r.height / 2;
    } catch (err) { after = false; }
    tr.classList.add(after ? 'drop-below' : 'drop-above');
  }

  function onDrop(e) {
    if (dragIdx === null || !active) return;
    const tr = rowOf(e);
    if (!tr) { endDrag(); return; }
    e.preventDefault();
    const from = dragIdx;
    const target = parseInt(tr.dataset.idx, 10);
    const after = tr.classList.contains('drop-below');
    endDrag();
    if (isNaN(from) || isNaN(target)) return;
    if (moveRowTo(from, target, after) && filterActive()) {
      M.toast('已移动到目标行' + (after ? '之后' : '之前') + '（当前有筛选，按可见顺序移动）');
    }
  }

  function filterActive() {
    const kw = document.getElementById('searchInput');
    if (kw && kw.value.trim()) return true;
    const ctrls = document.querySelectorAll('#tableHead .col-filter');
    for (let i = 0; i < ctrls.length; i++) {
      const v = ctrls[i].value;
      if (v && v !== '__all__') return true;
    }
    return false;
  }

  /* ---------------- 列管理 ---------------- */
  function openColMgr() {
    if (!active) return;
    const ids = groups.filter(g => g.key === groupKeyOf(curId()))[0].ids;
    const cols = window.ISYS.colsOf(ids[0]);
    const scopeTip = ids.length > 1
      ? '改动将同步到：' + ids.map(id => pageObj(id).name).join(' / ')
      : '仅作用于：' + pageObj(ids[0]).name;

    const typeOf = c => (c.options && c.options.length) ? 'select' : ((c.type === 'month' || c.key === 'devTime') ? 'month' : 'text');

    /* data-key 保存该列的原始标识：排序 / 删除都靠它认列，不能用位置下标 */
    const rowHtml = cols.map(function (c, i) {
      const t = typeOf(c);
      return '<div class="cm-row" data-key="' + esc(c.key) + '">' +
        '<span class="cm-no">' + (i + 1) + '</span>' +
        '<input class="cm-label" value="' + esc(c.label) + '" placeholder="列名">' +
        '<select class="cm-type">' +
          '<option value="text"' + (t === 'text' ? ' selected' : '') + '>文本</option>' +
          '<option value="select"' + (t === 'select' ? ' selected' : '') + '>枚举(下拉)</option>' +
          '<option value="month"' + (t === 'month' ? ' selected' : '') + '>年月</option>' +
        '</select>' +
        '<input class="cm-opts" value="' + esc((c.options || []).join('，')) + '" placeholder="枚举项，逗号分隔">' +
        '<button class="cm-mv" data-d="-1" title="上移">↑</button>' +
        '<button class="cm-mv" data-d="1" title="下移">↓</button>' +
        '<button class="cm-rm" title="删除该列">✕</button>' +
      '</div>';
    }).join('');

    const m = M.open({
      title: '管理列',
      desc: scopeTip,
      width: '760px',
      bodyHtml:
        '<div class="cm-head"><span>序号</span><span>列名</span><span>类型</span><span>枚举选项</span><span>排序</span></div>' +
        '<div class="cm-list" id="cmList">' + rowHtml + '</div>' +
        '<button class="ghost-btn" id="cmAdd">＋ 添加列</button>' +
        '<div class="fm-warn" id="cmWarn" hidden></div>' +
        '<div class="fm-err" id="cmErr"></div>',
      buttons: [
        { text: '取消', cls: 'ghost-btn', close: true },
        {
          text: '保存并应用', cls: 'primary-btn', close: false,
          onClick: function (root, close) { saveCols(root, close, ids, cols); }
        }
      ]
    });

    const list = m.el.querySelector('#cmList');

    /* 只更新显示用的序号，不再回写 data-i（否则删除/移动后会把列的身份搞混） */
    function renumber() {
      Array.prototype.forEach.call(list.children, function (r, i) {
        r.querySelector('.cm-no').textContent = i + 1;
      });
    }

    /* 列出本次将被删除的列（在弹窗里存在过、现在没有了） */
    function removedKeys() {
      const keep = {};
      Array.prototype.forEach.call(list.querySelectorAll('.cm-row'), function (r) {
        if (r.dataset.key) keep[r.dataset.key] = 1;
      });
      return cols.map(c => c.key).filter(k => !keep[k]);
    }

    function updateWarn() {
      const w = m.el.querySelector('#cmWarn');
      if (!w) return;
      const rm = removedKeys();
      if (!rm.length) { w.hidden = true; w.textContent = ''; return; }
      const names = rm.map(k => {
        const c = cols.filter(x => x.key === k)[0];
        return c ? c.label : k;
      });
      let nRows = 0;
      ids.forEach(id => { nRows += window.ISYS.rowsOf(id).length; });
      w.hidden = false;
      w.innerHTML = '⚠ 将删除 ' + rm.length + ' 列：<b>' + esc(names.join('、')) +
        '</b>，并清除这些列在 ' + ids.length + ' 个资料库共 ' + nRows + ' 行中的数据（保存后可撤销）';
    }

    updateWarn();

    list.addEventListener('click', function (e) {
      const mv = e.target.closest('.cm-mv');
      if (mv) {
        const row = mv.closest('.cm-row');
        const d = parseInt(mv.dataset.d, 10);
        if (d < 0 && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
        if (d > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
        renumber();
        return;
      }
      const rm = e.target.closest('.cm-rm');
      if (rm) {
        rm.closest('.cm-row').remove();
        renumber();
        updateWarn();
      }
    });

    m.el.querySelector('#cmAdd').addEventListener('click', function () {
      const div = document.createElement('div');
      div.className = 'cm-row';
      div.dataset.key = '';        /* 新建列还没有标识，保存时自动分配 */
      div.innerHTML =
        '<span class="cm-no"></span>' +
        '<input class="cm-label" value="新列" placeholder="列名">' +
        '<select class="cm-type"><option value="text">文本</option><option value="select">枚举(下拉)</option><option value="month">年月</option></select>' +
        '<input class="cm-opts" value="" placeholder="枚举项，逗号分隔">' +
        '<button class="cm-mv" data-d="-1" title="上移">↑</button>' +
        '<button class="cm-mv" data-d="1" title="下移">↓</button>' +
        '<button class="cm-rm" title="删除该列">✕</button>';
      list.appendChild(div);
      renumber();
    });
  }

  function saveCols(root, close, ids, oldCols) {
    const list = root.querySelector('#cmList');
    const err = root.querySelector('#cmErr');
    const rows = Array.prototype.slice.call(list.querySelectorAll('.cm-row'));

    const next = [];
    const used = {};
    let ok = true, msg = '';

    rows.forEach(function (r, i) {
      const label = r.querySelector('.cm-label').value.trim();
      const type = r.querySelector('.cm-type').value;
      const optRaw = r.querySelector('.cm-opts').value.trim();
      /* 按 key 认列，不用位置下标：删除或调整顺序后，其余列仍能对上自己的配置 */
      const base = (r.dataset.key && oldCols.filter(c => c.key === r.dataset.key)[0]) || {};

      if (!label) { ok = false; msg = '第 ' + (i + 1) + ' 列列名不能为空'; return; }
      if (used[label]) { ok = false; msg = '列名「' + label + '」重复'; return; }
      used[label] = 1;

      const col = {
        key: base.key || newKey(next.concat(oldCols)),
        label: label,
        width: base.width || '120px'
      };
      if (base.maxWidth) col.maxWidth = base.maxWidth;   /* 列宽上限，不填则用默认 420px */
      if (base.userWidth) col.userWidth = base.userWidth; /* 用户拖出来的定宽，改列名后依然保留 */
      if (type === 'select') {
        const opts = optRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (!opts.length) { ok = false; msg = '第 ' + (i + 1) + ' 列是枚举类型，至少填一个选项'; return; }
        col.filter = 'select';
        col.options = opts;
      } else if (type === 'month') {
        /* 年月类型：持久化到列定义，否则保存后识别不回来 */
        col.type = 'month';
        col.filter = (base.filter === 'select') ? 'text' : (base.filter || 'text');
      } else {
        col.filter = (base.filter === 'select') ? 'text' : (base.filter || 'text');
      }
      if (base.link) col.link = base.link;
      next.push(col);
    });

    if (!ok) { err.textContent = msg; return; }
    if (!next.length) { err.textContent = '至少保留一列'; return; }

    /* 被删掉的列：连同它在每一行里的数据一起清除，而不是只把表头藏起来 */
    const kept = {};
    next.forEach(c => { kept[c.key] = 1; });
    const removed = oldCols.map(c => c.key).filter(k => !kept[k]);
    const removedNames = removed.map(function (k) {
      const c = oldCols.filter(x => x.key === k)[0];
      return c ? c.label : k;
    }).join('、');

    /* 拍照入历史：列定义与各库行数据会一起还原 */
    record('修改列结构' + (removed.length ? '（删除 ' + removed.length + ' 列：' + removedNames + '）' : ''));

    if (removed.length) {
      ids.forEach(function (id) {
        window.ISYS.rowsOf(id).forEach(function (row) {
          removed.forEach(function (k) { delete row[k]; });
        });
      });
    }

    ids.forEach(id => { pageObj(id).columns = next; });
    persist();
    window.ISYS.rebuild();
    updateStatus();
    close();

    M.toast('列结构已更新（' + ids.length + ' 个库同步）' +
      (removed.length ? '，已删除 ' + removed.length + ' 列及其全部数据' : ''), {
      text: '撤销',
      onClick: function () { undo(); }   /* 统一走操作历史 */
    });
  }

  function newKey(existing) {
    const used = {};
    existing.forEach(c => { used[c.key] = 1; });
    let n = 1;
    while (used['custom' + n]) n++;
    return 'custom' + n;
  }

  /* ---------------- 导出 data.js ---------------- */
  function sq(s) {
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
  }
  function arrLit(a) { return '[' + a.map(sq).join(', ') + ']'; }

  function optsRef(arr) {
    if (!arr || !arr.length) return null;
    const cands = [
      ['MODULE_TYPE_OPTIONS', typeof MODULE_TYPE_OPTIONS !== 'undefined' ? MODULE_TYPE_OPTIONS : null],
      ['CLOCK_OPTIONS', typeof CLOCK_OPTIONS !== 'undefined' ? CLOCK_OPTIONS : null],
      ['IR_OPTIONS', typeof IR_OPTIONS !== 'undefined' ? IR_OPTIONS : null],
      ['YES_NO_OPTIONS', typeof YES_NO_OPTIONS !== 'undefined' ? YES_NO_OPTIONS : null]
    ];
    for (let i = 0; i < cands.length; i++) {
      if (cands[i][1] && JSON.stringify(cands[i][1]) === JSON.stringify(arr)) return cands[i][0];
    }
    return null;
  }

  function colLit(c) {
    let s = '{ key: ' + sq(c.key) + ', label: ' + sq(c.label) + ', width: ' + sq(c.width || '120px');
    if (c.maxWidth) s += ', maxWidth: ' + sq(String(c.maxWidth));
    /* 用户手动拖出来的列宽，导出时一并带走 */
    if (c.userWidth) s += ', userWidth: ' + Number(c.userWidth);
    s += ', filter: ' + sq(c.filter || 'text');
    if (c.type) s += ', type: ' + sq(c.type);
    if (c.options && c.options.length) {
      const ref = optsRef(c.options);
      s += ', options: ' + (ref || arrLit(c.options));
    }
    if (c.link) s += ', link: ' + sq(c.link);
    return s + ' }';
  }

  function rowLit(row, cols) {
    const parts = [];
    cols.forEach(function (c) {
      const v = row[c.key];
      if (v === undefined || v === null || v === '') return;
      parts.push(c.key + ':' + sq(v));
    });
    return '  { ' + parts.join(', ') + ' }';
  }

  const ROW_CONST = { mp: 'MP_ROWS', smd: 'SMD_ROWS', bd: 'BD_ROWS', lens: 'LENS_ROWS', sensor: 'SENSOR_ROWS', vcm: 'VCM_ROWS' };
  const COL_CONST = { mp: 'MODULE_COLUMNS', smd: 'MODULE_COLUMNS', bd: 'MODULE_COLUMNS', lens: 'LENS_COLUMNS', sensor: 'SENSOR_COLUMNS', vcm: 'VCM_COLUMNS' };

  function buildDataJs() {
    const today = new Date();
    const d = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const pages = window.ISYS.pages();
    const L = [];

    L.push('/* ============================================================');
    L.push(' * ISYS 器件开发知识库 —— 内置数据源（纯静态，无后端）');
    L.push(' * 本文件由页面「编辑模式 → 导出 data.js」生成于 ' + d + '，直接覆盖同名文件即可');
    L.push(' *');
    L.push(' * 列配置说明：');
    L.push(' *   key      字段标识');
    L.push(' *   label    表头文字');
    L.push(' *   width    最小列宽');
    L.push(' *   maxWidth 最大列宽（不填默认 420px），内容更长时换行、行高自动增加');
    L.push(' *   filter   \'select\' 下拉筛选 | \'text\' 关键字筛选');
    L.push(' *   options  下拉可选项（不填时自动从该列数据中去重生成）');
    L.push(' *   link     点击单元格跳转到指定资料库（值为目标库 id）');
    L.push(' * ============================================================ */');
    L.push('');
    L.push('/* ---------------- 通用可选项 ---------------- */');
    L.push('const MODULE_TYPE_OPTIONS = ' + arrLit(typeof MODULE_TYPE_OPTIONS !== 'undefined' ? MODULE_TYPE_OPTIONS : []) + ';');
    L.push('');
    L.push('/* 成像方向：几点钟方向（1 点 ~ 12 点） */');
    L.push('const CLOCK_OPTIONS = ' + arrLit(typeof CLOCK_OPTIONS !== 'undefined' ? CLOCK_OPTIONS : []) + ';');
    L.push('');
    L.push('/* IR 滤光片：蓝波 / 白波 */');
    L.push('const IR_OPTIONS = ' + arrLit(typeof IR_OPTIONS !== 'undefined' ? IR_OPTIONS : []) + ';');
    L.push('');
    L.push('/* 二值项：是 / 否 */');
    L.push('const YES_NO_OPTIONS = ' + arrLit(typeof YES_NO_OPTIONS !== 'undefined' ? YES_NO_OPTIONS : ['是', '否']) + ';');
    L.push('');

    /* 列常量：每个分组输出一份 */
    const doneGroups = {};
    pages.forEach(function (p) {
      const gk = groupKeyOf(p.id);
      if (doneGroups[gk]) return;
      doneGroups[gk] = 1;
      const name = COL_CONST[gk] || (gk.toUpperCase() + '_COLUMNS');
      L.push('/* ---------------- ' + name.replace('_COLUMNS', '') + ' 表头 ---------------- */');
      L.push('const ' + name + ' = [');
      window.ISYS.colsOf(p.id).forEach(function (c, i, arr) {
        L.push('  ' + colLit(c) + (i === arr.length - 1 ? '' : ','));
      });
      L.push('];');
      L.push('');
    });

    /* 行数据 */
    pages.forEach(function (p) {
      const name = ROW_CONST[p.id] || (p.id.toUpperCase() + '_ROWS');
      L.push('/* ---------------- ' + p.page.name + ' ---------------- */');
      L.push('const ' + name + ' = [');
      const cols = window.ISYS.colsOf(p.id);
      p.page.rows.forEach(function (r, i, arr) {
        L.push(rowLit(r, cols) + (i === arr.length - 1 ? '' : ','));
      });
      L.push('];');
      L.push('');
    });

    /* LIBRARIES */
    L.push('/* ============================================================');
    L.push(' * 页面结构定义（左侧树形导航 + 右侧页面配置）');
    L.push(' * ============================================================ */');
    L.push('const LIBRARIES = [');

    const libBlocks = [];
    (typeof LIBRARIES !== 'undefined' ? LIBRARIES : []).forEach(function (lib) {
      const head = ['  {', '    id: ' + sq(lib.id) + ',', '    name: ' + sq(lib.name) + ','];
      if (lib.icon) head.push('    icon: ' + sq(lib.icon) + ',');
      if (lib.desc) head.push('    desc: ' + sq(lib.desc) + ',');

      if (lib.children) {
        const kids = lib.children.map(function (c) {
          const fo = c.filterOptions || [];
          const foRef = optsRef(fo);
          return [
            '      {',
            '        id: ' + sq(c.id) + ',',
            '        name: ' + sq(c.name) + ',',
            '        desc: ' + sq(c.desc || '') + ',',
            '        columns: ' + (COL_CONST[c.id] || (c.id.toUpperCase() + '_COLUMNS')) + ',',
            '        rows: ' + (ROW_CONST[c.id] || (c.id.toUpperCase() + '_ROWS')) + ',',
            '        filterKey: ' + sq(c.filterKey) + ',',
            '        filterLabel: ' + sq(c.filterLabel) + ',',
            '        filterOptions: ' + (foRef || arrLit(fo)) + ',',
            '        placeholder: ' + (c.placeholder || 0),
            '      }'
          ].join('\n');
        });
        head.push('    children: [');
        head.push(kids.join(',\n'));
        head.push('    ]');
      } else {
        const fo = lib.filterOptions || [];
        const foRef = optsRef(fo);
        head.push('    columns: ' + (COL_CONST[lib.id] || (lib.id.toUpperCase() + '_COLUMNS')) + ',');
        head.push('    rows: ' + (ROW_CONST[lib.id] || (lib.id.toUpperCase() + '_ROWS')) + ',');
        head.push('    filterKey: ' + sq(lib.filterKey) + ',');
        head.push('    filterLabel: ' + sq(lib.filterLabel) + ',');
        head.push('    filterOptions: ' + (foRef || arrLit(fo)) + ',');
        if (lib.modelKey) head.push('    modelKey: ' + sq(lib.modelKey) + ',');
        head.push('    placeholder: ' + (lib.placeholder || 0));
      }
      head.push('  }');
      libBlocks.push(head.join('\n'));
    });

    L.push(libBlocks.join(',\n'));
    L.push('];');
    L.push('');
    L.push('const LIB_META = {');
    L.push("  updated: '" + d + "'");
    L.push('};');
    L.push('');

    /* 文件库数据（文档 / 压缩包）：随 data.js 导出与云端同步一起保存 */
    if (window.ISYS_Files && typeof window.ISYS_Files.exportJs === 'function') {
      L.push('/* ---------------- 文件库（文档 / 压缩包） ---------------- */');
      L.push(window.ISYS_Files.exportJs());
      L.push('');
    }

    return L.join('\n');
  }

  function exportDataJs() {
    const text = buildDataJs();
    download('data.js', text, 'text/javascript;charset=utf-8');
    M.toast('已导出 data.js，覆盖同名文件即可生效');
  }

  function download(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      M.toast('当前环境不支持直接下载，请改用浏览器打开页面');
    }
  }

  /* ---------------- 重置 ---------------- */
  function resetAll() {
    M.open({
      title: '重置为初始数据',
      desc: '将丢弃本地所有未导出的编辑，恢复到 data.js 的原始内容',
      width: '420px',
      bodyHtml: '<div class="fm-tip">已改动 <b>' + changedCount() + '</b> 处。若需要保留，请先「导出 data.js」。</div>',
      buttons: [
        { text: '取消', cls: 'ghost-btn', close: true },
        {
          text: '确认重置', cls: 'danger-btn', close: false,
          onClick: function (root, close) { ld(STORE); location.reload(); }
        }
      ]
    });
  }

  /* ---------------- 事件绑定（只绑一次，只读态下不生效） ---------------- */
  function bindTable() {
    const tb = tbody();
    if (!tb) return;

    tb.addEventListener('dblclick', function (e) {
      if (!active) return;
      const td = e.target.closest('td[data-col]');
      if (!td) return;
      const tr = td.closest('tr');
      startEdit(parseInt(tr.dataset.idx, 10), td.dataset.col);
    });

    tb.addEventListener('click', function (e) {
      if (!active) return;

      /* ↑ / ↓ 一步移动 */
      const mv = e.target.closest('.row-mv');
      if (mv) {
        e.preventDefault();
        e.stopPropagation();
        stepMove(parseInt(mv.dataset.idx, 10), parseInt(mv.dataset.d, 10));
        return;
      }

      const edit = e.target.closest('.cell-edit');
      if (edit) {
        e.preventDefault();
        e.stopPropagation();
        const td = edit.closest('td[data-col]');
        const tr = td.closest('tr');
        startEdit(parseInt(tr.dataset.idx, 10), td.dataset.col);
        return;
      }

      const del = e.target.closest('.row-del');
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        delRow(parseInt(del.dataset.idx, 10));
      }
    });

    /* 拖拽排序：事件都冒泡到 tbody，用委托绑定，重绘后无需重新绑定 */
    tb.addEventListener('dragstart', onDragStart);
    tb.addEventListener('dragover', onDragOver);
    tb.addEventListener('dragleave', function (e) {
      const tr = rowOf(e);
      if (tr) tr.classList.remove('drop-above', 'drop-below');
    });
    tb.addEventListener('drop', onDrop);
    tb.addEventListener('dragend', endDrag);
  }

  /* ---------------- 状态切换 ---------------- */
  function syncState() {
    active = A.isUnlocked();
    if (!active) endDrag();
    document.body.classList.toggle('edit-on', active);
    renderAuthZone();
    if (window.ISYS) {
      window.ISYS.refreshTree();
      window.ISYS.rebuild();
    }
    updateStatus();
    renderHistory();
  }

  /* 以当前云端/本地数据为基线，重算列分组与指纹（云端数据热替换后由 app.js 调用） */
  function resync() {
    if (!window.ISYS) return;   // app.js 未就绪时跳过，避免中断初始化
    groups = buildGroups();
    sig = { rows: {}, cols: {} };
    window.ISYS.pages().forEach(p => { sig.rows[p.id] = hash(p.page.rows); });
    groups.forEach(g => { sig.cols[g.key] = hash(window.ISYS.colsOf(g.ids[0])); });
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    if (window.ISYS_Sync && window.ISYS_Sync.enabled()) {
      resync();   // 云端态：以云端数据为基线，不套用本地缓存（避免覆盖他人改动）
    } else {
      applySaved();
    }
    bindTable();
    bindHistoryGlobal();
    A.onChange(syncState);
    syncState();
    /* 只读态下也刷新一次，保证本地缓存的数据体现在首屏 */
    if (!active && window.ISYS) { window.ISYS.refreshTree(); window.ISYS.rerender(); }
    updateStatus();
  }

  window.ISYS_Edit = {
    active: function () { return active; },
    init: init,
    resync: resync,
    /* 供校验脚本使用：返回「导出 data.js」将生成的文件内容 */
    exportText: buildDataJs,
    /* 供校验脚本使用：移动行 */
    moveRow: moveRowTo,
    stepMove: stepMove,
    visibleRealIdx: visibleRealIdx,
    /* 列宽拖拽后由 app.js 调用，把 userWidth 写进本地缓存 */
    persist: persist,
    /* 操作历史：undo/redo 传 true 表示静默（不弹提示） */
    undo: undo,
    redo: redo,
    jump: jump,
    history: function () {
      return {
        past: past.map(e => e.label),
        future: future.map(e => e.label),
        max: HIST_MAX
      };
    },
    clearHistory: function () { past = []; future = []; pending = null; renderHistory(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
