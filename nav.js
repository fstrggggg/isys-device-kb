/* ============================================================
 * ISYS 开发平台 —— 一级 / 二级目录导航配置
 *
 * 设备资料（模组资料库 / 二级器件）直接复用 data.js 里的 LIBRARIES：
 *   - module  分组 = mp / smd / bd
 *   - secondary 分组 = lens / sensor / vcm
 * 分组下的子项 id 必须在 LIBRARIES 中真实存在（app.js 用 pageMap 反查名称/行数）。
 *
 * 四个文件型一级目录（项目管理 / 知识库 / 工具 / 标准化管理）由 filetree.js 接管，
 * 支持任意层级子目录 + 文件导入 + 网页预览。
 * ============================================================ */
window.ISYS_NAV = {
  groups: [
    {
      id: 'module',
      name: '模组资料库',
      icon: '📦',
      desc: 'Camera 模组规格清单，按量产阶段拆分。',
      children: ['mp', 'smd', 'bd']
    },
    {
      id: 'secondary',
      name: '二级器件',
      icon: '🔬',
      desc: '镜头 / 传感器 / VCM 等二级器件规格与选型。',
      children: ['lens', 'sensor', 'vcm']
    }
  ],

  /* 文件型一级目录（自由多级目录 + 文件导入预览） */
  fileRoots: [
    {
      id: 'proj',
      name: '项目管理',
      icon: '📂',
      desc: '按项目归档需求、方案、评审、进度等文档。可任意建立多级子目录并导入文件，支持网页内直接预览。'
    },
    {
      id: 'kb',
      name: '知识库',
      icon: '📚',
      desc: '技术经验、规范、案例沉淀。支持任意层级目录与文件导入预览。'
    },
    {
      id: 'tools',
      name: '工具',
      icon: '🛠',
      desc: '软件工具、脚本、模板、计算器等归档与下载。'
    },
    {
      id: 'std',
      name: '标准化管理',
      icon: '📐',
      desc: '标准、流程、模板、Checklist 等标准化文件的归档与管理。'
    }
  ]
};
