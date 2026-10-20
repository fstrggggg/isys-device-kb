/* ============================================================
 * ISYS 器件开发知识库 —— 编辑权限（前端软锁）+ 通用弹窗
 * ============================================================
 *
 * 【重要 · 安全边界说明】
 * 本页是纯静态站点，没有后端。口令校验完全在浏览器里完成，
 * 因此它只能「防止随手误改 / 让只读与编辑状态泾渭分明」，
 * 不能防御有意破解——任何能打开页面并查看源码的人都能绕过。
 * 若需要真正的权限控制，必须接入后端或企业SSO鉴权。
 *
 * 【如何改口令】
 * 方式一（临时）：解锁后点顶部「修改口令」，新口令存于浏览器 localStorage，
 *                 只对当前浏览器生效，换机器/清缓存即恢复下面的内置口令。
 * 方式二（永久）：修改下方 BUILTIN_HASH，重新分发 auth.js 文件。
 *                 生成方法：sha256(SALT + 新口令)，可用 `_hash.js` 脚本计算。
 *
 * 口令：ISYS@2026
 * ============================================================ */

(function (global) {
  'use strict';

  /* ---------------- 配置 ---------------- */
  var SALT = 'isys-kb-2026';
  /* sha256(SALT + 'ISYS@2026') */
  var BUILTIN_HASH = 'ab3683eca2e28c82a4678dc421036e7acb86c1d25bb20ce5ff554b80e67bce5b';

  var KEY_UNLOCKED  = 'isys_kb_unlocked';    // '1' = 已解锁（长期有效，直到手动锁定）
  var KEY_HASH      = 'isys_kb_passhash';    // 用户自定义口令哈希（覆盖内置）
  var KEY_FAILS     = 'isys_kb_authfails';   // 连续失败次数
  var KEY_BLOCK     = 'isys_kb_blockuntil';  // 失败过多时的临时封禁截止时间

  var MAX_FAILS = 5;          // 连续错误 5 次
  var BLOCK_MS  = 60 * 1000;  // 临时锁定 60 秒

  /* ---------------- 存储（localStorage 不可用时退化为内存） ---------------- */
  var mem = {};
  var ls = (function () {
    try {
      var t = '__isys_t__';
      global.localStorage.setItem(t, '1');
      global.localStorage.removeItem(t);
      return global.localStorage;
    } catch (e) { return null; }
  })();

  function get(k) {
    try { return ls ? ls.getItem(k) : (mem[k] == null ? null : mem[k]); }
    catch (e) { return mem[k] == null ? null : mem[k]; }
  }
  function set(k, v) {
    mem[k] = String(v);
    try { if (ls) ls.setItem(k, String(v)); } catch (e) { /* 忽略配额错误 */ }
  }
  function del(k) {
    delete mem[k];
    try { if (ls) ls.removeItem(k); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- SHA-256（自带实现，file:// 下也可用） ---------------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256(str) {
    var m = utf8Bytes(String(str));
    var bitLen = m.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    m.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
           (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var i, t;

    for (i = 0; i < m.length; i += 64) {
      for (t = 0; t < 16; t++) {
        w[t] = ((m[i + t * 4] << 24) | (m[i + t * 4 + 1] << 16) |
                (m[i + t * 4 + 2] << 8) | m[i + t * 4 + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var a0 = w[t - 15], a1 = w[t - 2];
        var s0 = (rotr(a0, 7) ^ rotr(a0, 18) ^ (a0 >>> 3)) >>> 0;
        var s1 = (rotr(a1, 17) ^ rotr(a1, 19) ^ (a1 >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var mj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) hex += ('00000000' + H[i].toString(16)).slice(-8);
    return hex;
  }

  /* ---------------- 权限状态 ---------------- */
  var listeners = [];
  function emit() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略 */ } }); }

  function currentHash() { return get(KEY_HASH) || BUILTIN_HASH; }

  function isUnlocked() { return get(KEY_UNLOCKED) === '1'; }

  function remainingBlock() {
    var until = parseInt(get(KEY_BLOCK), 10) || 0;
    var left = until - Date.now();
    return left > 0 ? left : 0;
  }

  function unlock(pwd) {
    var left = remainingBlock();
    if (left) return { ok: false, msg: '尝试次数过多，请 ' + Math.ceil(left / 1000) + ' 秒后再试' };
    if (!pwd) return { ok: false, msg: '请输入口令' };

    if (sha256(SALT + pwd) === currentHash()) {
      set(KEY_UNLOCKED, '1');
      del(KEY_FAILS); del(KEY_BLOCK);
      emit();
      return { ok: true, msg: '编辑权限已开通' };
    }
    var f = (parseInt(get(KEY_FAILS), 10) || 0) + 1;
    set(KEY_FAILS, String(f));
    if (f >= MAX_FAILS) {
      set(KEY_BLOCK, String(Date.now() + BLOCK_MS));
      return { ok: false, msg: '口令错误 ' + f + ' 次，已临时锁定 60 秒' };
    }
    return { ok: false, msg: '口令错误，还可尝试 ' + (MAX_FAILS - f) + ' 次' };
  }

  function lock() {
    del(KEY_UNLOCKED);
    emit();
  }

  function changePassword(oldPwd, newPwd, newPwd2) {
    if (!isUnlocked()) return { ok: false, msg: '请先解锁编辑权限' };
    if (sha256(SALT + oldPwd) !== currentHash()) return { ok: false, msg: '当前口令不正确' };
    if (!newPwd || newPwd.length < 4) return { ok: false, msg: '新口令至少 4 位' };
    if (newPwd !== newPwd2) return { ok: false, msg: '两次输入的新口令不一致' };
    set(KEY_HASH, sha256(SALT + newPwd));
    return { ok: true, msg: '口令已修改（仅当前浏览器生效）' };
  }

  function resetPassword() {
    del(KEY_HASH); del(KEY_FAILS); del(KEY_BLOCK);
    return { ok: true, msg: '已恢复为内置口令' };
  }

  /* ---------------- 通用弹窗 ---------------- */
  var modalRoot = null;
  function root() {
    if (!modalRoot) {
      modalRoot = document.getElementById('modalRoot');
      if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'modalRoot';
        document.body.appendChild(modalRoot);
      }
    }
    return modalRoot;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* open({ title, desc, bodyHtml, width, buttons:[{text, cls, close, onClick(root, close)}] }) */
  function open(opt) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-mask';
    wrap.innerHTML =
      '<div class="modal" style="' + (opt.width ? 'width:' + opt.width : '') + '">' +
        '<div class="modal-head">' +
          '<h3>' + esc(opt.title || '') + '</h3>' +
          '<button class="modal-x" title="关闭">&times;</button>' +
        '</div>' +
        (opt.desc ? '<div class="modal-desc">' + esc(opt.desc) + '</div>' : '') +
        '<div class="modal-body">' + (opt.bodyHtml || '') + '</div>' +
        '<div class="modal-foot"></div>' +
      '</div>';

    function close() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    var foot = wrap.querySelector('.modal-foot');
    (opt.buttons || [{ text: '关闭', cls: 'ghost-btn' }]).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = b.cls || 'ghost-btn';
      btn.textContent = b.text;
      btn.addEventListener('click', function () {
        if (b.onClick) b.onClick(wrap, close);
        if (b.close !== false && !(b.onClick && b.onClick.length > 1)) { /* 交由 onClick 决定 */ }
        if (b.close) close();
      });
      foot.appendChild(btn);
    });

    wrap.querySelector('.modal-x').addEventListener('click', close);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);

    root().appendChild(wrap);
    var first = wrap.querySelector('input, select, textarea');
    if (first) first.focus();
    return { el: wrap, close: close };
  }

  /* ---------------- 轻提示（带可选操作按钮） ---------------- */
  function toast(msg, action) {
    var box = document.getElementById('toastRoot');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastRoot';
      box.className = 'toast-root';
      document.body.appendChild(box);
    }
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span class="toast-msg">' + esc(msg) + '</span>';
    if (action) {
      var btn = document.createElement('button');
      btn.className = 'toast-btn';
      btn.textContent = action.text;
      btn.addEventListener('click', function () {
        action.onClick();
        if (t.parentNode) t.parentNode.removeChild(t);
      });
      t.appendChild(btn);
    }
    box.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, action ? 6000 : 2600);
    return t;
  }

  global.ISYS_Auth = {
    /* 状态 */
    isUnlocked: isUnlocked,
    unlock: unlock,
    lock: lock,
    changePassword: changePassword,
    resetPassword: resetPassword,
    remainingBlock: remainingBlock,
    onChange: function (fn) { listeners.push(fn); },
    /* 工具 */
    sha256: sha256,
    config: { SALT: SALT, MAX_FAILS: MAX_FAILS, BLOCK_MS: BLOCK_MS }
  };
  global.ISYS_Modal = { open: open, toast: toast, esc: esc };

})(typeof window !== 'undefined' ? window : this);
