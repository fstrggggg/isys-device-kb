/* ============================================================
 * ISYS 器件开发知识库 —— 协同同步层（前端直连 GitHub 模式）
 *
 * 数据流向（默认「纯静态优先」模式）：
 *   打开页面 → 直接渲染内置 data.js（已含全部数据，无需任何网络请求）→ 完成
 *   数据已全部静态化：任何人打开链接即可查看 / 搜索全部内容，不再受令牌失效影响。
 *
 *   配置真实 fine-grained PAT（且把 enabled 设为 true）后，自动升级为「云端同步模式」：
 *     编辑保存 → 防抖 2.5s → PUT 写回 GitHub data.json
 *     每 30s 轮询一次，其他设备/人的改动即时可见
 *
 * ⚠️ 安全说明（务必知悉）：
 *   本模式把 GitHub 细粒度令牌直接放在前端 JS 中，任何打开该链接的人
 *   都能从浏览器源码看到此令牌。该令牌已被限制为：
 *     - 仅对仓库 fstrggggg/isys-device-kb 有效
 *     - 仅拥有 Contents 读+写权限
 *   最坏情况下，拿到令牌的人只能改写这一个仓库的 data.json（可用 git 历史恢复）。
 *   若需更高安全性，应改用「自有服务器/云函数做后端代理」或「WorkBuddy 云数据库」，
 *   让令牌只留在服务端。当前为满足「链接直接同步 GitHub」的需求采用了前端直连。
 * ============================================================ */

window.ISYS_SYNC_CONFIG = window.ISYS_SYNC_CONFIG || {
  enabled: true,
  mode: 'github-direct',                 // 前端直接调用 GitHub API（令牌在前端）
  owner: 'fstrggggg',
  repo: 'isys-device-kb',
  branch: 'main',
  path: 'data.json',
  // 令牌由 GitHub Actions 从仓库 Secret(ISYS_SYNC_TOKEN) 注入；仓库内仅此占位符，不含真实令牌
  token: '__ISYS_SYNC_TOKEN__',
  fallbackToLocal: true
};

(function (global) {
  'use strict';

  var CONFIG = global.ISYS_SYNC_CONFIG || {};
  var PULL_MS = 30000;        // 自动轮询间隔（毫秒）
  var PUSH_DEBOUNCE = 2500;   // 编辑后防抖提交（毫秒）

  var lastSig = null;         // 最近一次数据的特征串（用于判断是否有变化）
  var lastSha = null;         // GitHub 上 data.json 的当前 blob sha（写回时防冲突）
  var dirty = false;          // 是否有未推送的本地改动
  var pushTimer = null;
  var pullTimer = null;

  // 纯静态优先：未配置真实令牌（仍是占位符或为空）时，视为纯静态模式——
  // 首屏直接渲染内置 data.js（已含全部数据），不发起任何网络请求，打开即用。
  // 配置真实 fine-grained PAT（且把 enabled 设为 true）后，自动恢复云端同步。
  function enabled() {
    var hasToken = CONFIG.token && CONFIG.token.indexOf('__ISYS_SYNC_TOKEN__') === -1 && CONFIG.token.trim() !== '';
    return !!CONFIG.enabled && hasToken;
  }

  function apiUrl() {
    return 'https://api.github.com/repos/' + CONFIG.owner + '/' + CONFIG.repo +
           '/contents/' + CONFIG.path + '?ref=' + CONFIG.branch;
  }

  // 公开只读地址：无需令牌即可读取，保证「查看/搜索」在令牌失效时仍可用
  function rawUrl() {
    return 'https://raw.githubusercontent.com/' + CONFIG.owner + '/' + CONFIG.repo +
           '/' + CONFIG.branch + '/' + CONFIG.path;
  }

  function ghHeaders() {
    var h = { 'Accept': 'application/vnd.github+json' };
    if (CONFIG.token) h['Authorization'] = 'Bearer ' + CONFIG.token;
    return h;
  }

  // UTF-8 安全的 base64（内容含中文）
  function utob(str) { return btoa(unescape(encodeURIComponent(str))); }
  function btou(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\s+/g, '')))); }

  function setStatus(kind, text) {
    var badge = document.getElementById('syncBadge');
    var info = document.getElementById('syncInfo');
    if (badge) {
      badge.className = 'badge ' +
        (kind === 'online' ? 'badge-ok' : kind === 'syncing' ? 'badge-sync' : kind === 'static' ? 'badge-ok' : 'badge-off');
      badge.textContent = kind === 'syncing' ? '◌ 同步中' : kind === 'online' ? '● 已同步' : kind === 'static' ? '◆ 静态版' : '● 离线';
    }
    if (info) info.textContent = text || '';
  }

  function setDirty(v) {
    dirty = v;
    var pb = document.getElementById('syncPushBtn');
    if (pb) pb.classList.toggle('dirty', !!dirty);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function toast(msg) {
    if (global.ISYS_Modal && global.ISYS_Modal.toast) global.ISYS_Modal.toast(msg);
    else console.log('[ISYS] ' + msg);
  }

  function sigOf(libs) {
    try { return JSON.stringify(libs); } catch (e) { return null; }
  }

  /* ---------------- 读取 GitHub 上的 data.json ---------------- */
  function fetchRemote() {
    // 优先用公开 raw 地址（免令牌，无配额限制）；失败再回退到带令牌的 API（可拿到 sha 便于写回）
    return fetch(rawUrl(), { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var json = JSON.parse(text);
        return { data: json, sha: lastSha };
      })
      .catch(function () {
        return fetch(apiUrl(), { method: 'GET', headers: ghHeaders(), cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (obj) {
            if (!obj || typeof obj.content !== 'string') throw new Error('非法响应');
            var json = JSON.parse(btou(obj.content));
            lastSha = obj.sha || lastSha;
            return { data: json, sha: obj.sha };
          });
      });
  }

  /* ---------------- 取当前 blob sha（写回前需要） ---------------- */
  function getSha(force) {
    if (lastSha && !force) return Promise.resolve(lastSha);
    return fetch(apiUrl(), { method: 'GET', headers: ghHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (obj) { lastSha = obj.sha; return obj.sha; });
  }

  /* ---------------- 写回 GitHub（last-write-wins，带 409 重试） ---------------- */
  function pushToCloud(message) {
    if (!enabled()) return Promise.reject(new Error('sync disabled'));
    var payload = {
      libraries: global.LIBRARIES,
      meta: Object.assign({}, global.LIB_META, { updated: todayStr() })
    };
    var b64 = utob(JSON.stringify(payload));

    function doPut(sha) {
      return fetch(apiUrl(), {
        method: 'PUT',
        headers: Object.assign(ghHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: message || 'ISYS 编辑更新',
          content: b64,
          sha: sha,
          branch: CONFIG.branch
        })
      }).then(function (r) {
        if (!r.ok) {
          var err = new Error('HTTP ' + r.status);
          if (r.status === 409) err.conflict = true;
          throw err;
        }
        return r.json();
      }).then(function (obj) {
        lastSha = (obj.content && obj.content.sha) || lastSha;
        setDirty(false);
        setStatus('online', '已同步 · ' + todayStr());
        return true;
      });
    }

    return getSha().then(doPut).catch(function (err) {
      // sha 冲突：重新拉取最新 sha 后重试一次
      if (err && err.conflict) {
        return getSha(true).then(doPut).catch(function (e2) {
          setStatus('offline', '离线·写入冲突（' + (e2 && e2.message ? e2.message : '合并失败') + '）');
          throw e2;
        });
      }
      setStatus('offline', '离线·写入失败（' + (err && err.message ? err.message : '网络错误') + '）');
      throw err;
    });
  }

  /* ---------------- 防抖提交 ---------------- */
  function schedulePush(message) {
    if (!enabled()) return;
    setDirty(true);
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      pushToCloud(message || '编辑更新').catch(function () {});
    }, PUSH_DEBOUNCE);
  }

  /* ---------------- 应用云端数据并重渲染 ---------------- */
  function applyRemote(res) {
    if (!res || !res.data) return;
    global.LIBRARIES = res.data.libraries;
    global.LIB_META = res.data.meta || global.LIB_META;
    lastSig = sigOf(global.LIBRARIES);
    if (global.ISYS && global.ISYS.reindex) global.ISYS.reindex();
    setStatus('online', '已同步 · ' + ((global.LIB_META && global.LIB_META.updated) || ''));
    if (global.ISYS && global.ISYS.rerender) global.ISYS.rerender();
    if (global.ISYS_Edit && global.ISYS_Edit.resync) global.ISYS_Edit.resync();
    var td = document.getElementById('topbarDate');
    if (td) td.textContent = '更新：' + ((global.LIB_META && global.LIB_META.updated) || '');
  }

  /* ---------------- 拉取（手动 / 自动） ---------------- */
  function pull(manual) {
    if (!enabled()) return;
    if (dirty && manual) { toast('你有未同步的本地改动，请先点「同步」'); return; }
    fetchRemote().then(function (res) {
      var sig = sigOf(res.data.libraries);
      if (sig && sig === lastSig) return;   // 无变化
      if (dirty) return;                     // 有本地改动，暂不覆盖
      applyRemote(res);
    }).catch(function (err) {
      setStatus('offline', '离线·拉取失败（' + (err && err.message ? err.message : '无法连接') + '）');
    });
  }

  /* ---------------- 启动：拉取云端 + 开启轮询 ---------------- */
  function bootstrap() {
    setStatus('syncing', '同步中…');
    fetchRemote().then(function (res) {
      applyRemote(res);
      pullTimer = setInterval(function () {
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        pull(false);
      }, PULL_MS);
    }).catch(function (err) {
      setStatus('offline', '离线·内置示例（' + (err && err.message ? err.message : '无法连接 GitHub') + '）');
    });
  }

  /* ---------------- 绑定顶栏按钮 ---------------- */
  function bindUI() {
    var pullBtn = document.getElementById('syncPullBtn');
    var pushBtn = document.getElementById('syncPushBtn');
    if (pullBtn) pullBtn.addEventListener('click', function () { pull(true); });
    if (pushBtn) pushBtn.addEventListener('click', function () {
      if (!enabled()) return;
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      pushToCloud('手动同步').catch(function () {});
    });
  }

  global.ISYS_Sync = {
    enabled: enabled,
    bootstrap: bootstrap,
    pull: pull,
    push: function (m) { return pushToCloud(m); },
    schedulePush: schedulePush,
    applyRemote: applyRemote
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
  else bindUI();

  // 纯静态模式：未配置真实令牌时，明确标记状态，首屏直接展示内置数据（零网络请求）
  if (!enabled()) setStatus('static', '纯静态 · 内置数据（' + ((global.LIB_META && global.LIB_META.updated) || '') + '）');
})(window);
