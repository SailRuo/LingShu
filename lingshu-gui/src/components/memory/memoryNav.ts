export interface MemoryNavItem {
  path: string;
  label: string;
  title: string;
  subtitle: string;
}

/**
 * 记忆页 tab 配置。顶部导航与页面标题共用一份，
 * 避免布局层（MemoryLayoutView）和各 tab 视图各写一遍标题。
 */
export const MEMORY_NAV_ITEMS: MemoryNavItem[] = [
  {
    path: '/memory-overview',
    label: '总览',
    title: '记忆总览',
    subtitle: '她记住了什么 · 各层一览',
  },
  {
    path: '/memory-streams',
    label: '意识流',
    title: '意识流',
    subtitle: '她记住的生活片段',
  },
  {
    path: '/memory-self-portrait',
    label: '她的自画像',
    title: '她的自画像',
    subtitle: '从相处里慢慢长出来的自我理解 · 只读',
  },
  {
    path: '/memory-graph',
    label: '图谱',
    title: '记忆图谱',
    subtitle: '全量记忆 · 实体/事实/心事线/种子/意识流（点图例按层开关）',
  },
  {
    path: '/memory-facts',
    label: '事实',
    title: '硬事实',
    subtitle: '当前 / 历史 / 按时间查看 · 每条可追溯原话',
  },
  {
    path: '/memory-boundaries',
    label: '规则',
    title: '边界与约定',
    subtitle: '她学会的规矩 · 记下的日子',
  },
  {
    path: '/memory-audit',
    label: '审计',
    title: '记忆审计',
    subtitle: 'Layer1 后台消化与记忆存量',
  },
];
