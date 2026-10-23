/* ============================================================
 * ISYS 开发平台 —— 文件树默认数据（内置，零网络）
 * 云端 filetree.json 存在时会被其覆盖（filetree.js 启动时拉取）。
 * 每个一级目录一个根文件夹，根下初始为空，由用户在网页内创建。
 * ============================================================ */
window.ISYS_FILE_TREES = {
  updated: '',
  trees: {
    proj:  { name: '项目管理',   root: { type: 'folder', name: '根目录', children: [] } },
    kb:    { name: '知识库',     root: { type: 'folder', name: '根目录', children: [] } },
    tools: { name: '工具',       root: { type: 'folder', name: '根目录', children: [] } },
    std:   { name: '标准化管理', root: { type: 'folder', name: '根目录', children: [] } }
  }
};
