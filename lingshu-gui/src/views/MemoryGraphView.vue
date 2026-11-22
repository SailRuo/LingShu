<script setup lang="ts">
import { onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Input as AInput } from '@arco-design/web-vue';
import * as echarts from 'echarts';
import { useMemoryApiContext } from '../composables/useMemoryApiContext';
import { useMemoryPageFilter } from '../composables/useMemoryPageFilter';
import { readMemoryNavQuery } from '../composables/useMemoryNavigation';

interface GraphNode {
  id: string;
  label: string;
  type: string;
  nodeClass: string;
  properties: {
    narrative?: string;
    about?: string;
    temperature?: number;
    effectiveTemperature?: number;
    unspoken?: string;
    created_at?: string;
    updated_at?: string;
    name?: string;
    type?: string;
    role?: string;
    kind?: string;
    valid_at?: string | null;
    invalid_at?: string | null;
    cardinality?: string;
    summary?: string | null;
    title?: string;
    status?: string;
    current_grip?: number;
    last_note?: string;
  };
}

interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
  properties?: {
    description?: string;
    confidence?: number;
    created_at?: string;
    valid_at?: string | null;
    invalid_at?: string | null;
    validAt?: string | null;
    invalidAt?: string | null;
  };
}

interface RelatedFact {
  relation: string;
  description: string;
  peerLabel: string;
  timeLabel?: string;
}

interface EntityDetail {
  id: string;
  nodeKind: 'Entity' | 'Thread';
  name: string;
  entityType: string;
  role?: string;
  kind?: string;
  narrative: string;
  createdAt: string | null;
  updatedAt?: string | null;
  validAt?: string | null;
  invalidAt?: string | null;
  status?: string;
  currentGrip?: number;
  relatedFacts: RelatedFact[];
}

const NODE_COLORS: Record<string, string> = {
  user: '#3b82f6',
  us: '#10b981',
  self: '#f43f5e',
  'user-center': '#9ca3af',
  memory: '#6b7280',
  'entity-user': '#3b82f6',
  'entity-person': '#f97316',
  'entity-location': '#10b981',
  'entity-organization': '#0ea5e9',
  'entity-concept': '#14b8a6',
  'entity-pet': '#eab308',
  'entity-object': '#a855f7',
  'entity-activity': '#f59e0b',
  'entity-event': '#8b5cf6',
  'entity-theme': '#06b6d4',
  'entity-emotion': '#ec4899',
  'entity-other': '#a855f7',
  'thread-open': '#ef4444',
  'thread-closed': '#64748b',
  seed: '#22d3ee',
  stream: '#94a3b8',
};

const ENTITY_KIND_LABELS: Record<string, string> = {
  person: '人物',
  location: '地点/组织',
  organization: '组织',
  pet: '宠物',
  concept: '偏好/概念',
  object: '物品',
  activity: '活动',
  event: '事件',
  theme: '主题',
  emotion: '情绪',
  other: '其他',
};

const ENTITY_ROLE_LABELS: Record<string, string> = {
  user: '用户(我)',
  self: '智能体',
  other: '其他',
};

// 图例分层：每个 chip 对应一组 nodeClass，可点击开关。默认意识流(stream)收起，免得糊成一团。
interface LegendGroup { key: string; label: string; sample: string; classes: string[] }
const LEGEND: LegendGroup[] = [
  { key: 'user', label: '用户(我)', sample: 'entity-user', classes: ['entity-user'] },
  { key: 'self', label: '智能体', sample: 'self', classes: ['self'] },
  { key: 'person', label: '人物', sample: 'entity-person', classes: ['entity-person'] },
  { key: 'location', label: '地点/组织', sample: 'entity-location', classes: ['entity-location', 'entity-organization'] },
  { key: 'concept', label: '偏好/概念', sample: 'entity-concept', classes: ['entity-concept'] },
  { key: 'pet', label: '宠物', sample: 'entity-pet', classes: ['entity-pet'] },
  { key: 'thread', label: '心事线', sample: 'thread-open', classes: ['thread-open', 'thread-closed'] },
  { key: 'other', label: '其他', sample: 'entity-other', classes: ['entity-other'] },
  { key: 'seed', label: '种子', sample: 'seed', classes: ['seed'] },
  { key: 'stream', label: '意识流', sample: 'stream', classes: ['stream'] },
];
const CLASS_TO_GROUP: Record<string, string> = Object.fromEntries(
  LEGEND.flatMap((g) => g.classes.map((c) => [c, g.key])),
);

const route = useRoute();
const agentFilter = useMemoryPageFilter();
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const searchText = ref('');

const loading = ref(false);
const errorText = ref('');
const nodes = ref<GraphNode[]>([]);
const links = ref<GraphLink[]>([]);
const selectedId = ref<string | null>(null);
const detail = ref<EntityDetail | null>(null);
// 默认把意识流层收起（量大、最容易糊）；其余层全开。
const hiddenGroups = ref<Set<string>>(new Set(['stream']));

function isGroupHidden(key: string): boolean {
  return hiddenGroups.value.has(key);
}

function toggleGroup(key: string) {
  const next = new Set(hiddenGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hiddenGroups.value = next;
  renderChart();
}

function isNodeVisible(nodeClass: string): boolean {
  const group = CLASS_TO_GROUP[nodeClass];
  return !group || !hiddenGroups.value.has(group);
}

const chartRef = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

function focusIdFromRoute(): string {
  const nav = readMemoryNavQuery(route.query as Record<string, string | string[] | null | undefined>);
  return String(route.query.entityId || nav.entityId || nav.impressionId || '').trim();
}

function matchNodeByFocusId(focusId: string): GraphNode | undefined {
  if (!focusId) return undefined;
  const direct = nodes.value.find((n) => n.id === focusId);
  if (direct) return direct;
  const threadPrefixed = nodes.value.find((n) => n.id === `thread:${focusId}`);
  if (threadPrefixed) return threadPrefixed;
  return nodes.value.find((n) => n.id.replace(/^thread:/, '') === focusId.replace(/^thread:/, ''));
}

function selectNode(node: GraphNode) {
  selectedId.value = node.id;
  detail.value = node.type === 'Thread' ? buildThreadDetail(node) : buildEntityDetail(node);
  const dataIndex = nodes.value.findIndex((n) => n.id === node.id);
  if (dataIndex >= 0 && chart) {
    chart.dispatchAction({ type: 'focusNodeAdjacency', seriesIndex: 0, dataIndex });
  }
}

function applySearchAndFocus() {
  const nav = readMemoryNavQuery(route.query as Record<string, string | string[] | null | undefined>);
  if (nav.query) searchText.value = nav.query;
  const focusId = focusIdFromRoute();
  if (focusId) {
    const node = matchNodeByFocusId(focusId);
    if (node) {
      selectNode(node);
      return;
    }
  }
  const q = searchText.value.trim().toLowerCase();
  if (!q) return;
  const node = nodes.value.find((n) => {
    const hay = `${n.label} ${n.properties.name || ''} ${n.properties.narrative || ''} ${n.properties.summary || ''} ${n.properties.title || ''}`.toLowerCase();
    return hay.includes(q);
  });
  if (node) selectNode(node);
}

function runSearch() {
  applySearchAndFocus();
}

function nodeColor(nodeClass: string): string {
  return NODE_COLORS[nodeClass] || NODE_COLORS.memory;
}

function nodeLabelById(id: string): string {
  const node = nodes.value.find((n) => n.id === id);
  return node?.properties.name || node?.label || id;
}

function entityRoleKey(node: GraphNode): string {
  const role = String(node.properties.role ?? '').trim().toLowerCase();
  if (role) return role;
  // v23 之前 type 兼作 role（user/self/other），仅按角色值兜底。
  const legacy = String(node.properties.type ?? '').trim().toLowerCase();
  return legacy === 'user' || legacy === 'self' || legacy === 'other' ? legacy : '';
}

function entityKindKey(node: GraphNode): string {
  const kind = String(node.properties.kind ?? '').trim().toLowerCase();
  // 旧数据的 type 可能直接是 person/location 等实体类型；v23 迁移默认 kind='other' 时要回退。
  const legacy = String(node.properties.type ?? '').trim().toLowerCase();
  const legacyKind = legacy && legacy !== 'other' && ENTITY_KIND_LABELS[legacy] ? legacy : '';
  if (kind && kind !== 'other') return kind;
  if (legacyKind) return legacyKind;
  return kind;
}

function entityTypeLabel(node: GraphNode): string {
  const role = entityRoleKey(node);
  if (role === 'user') return ENTITY_ROLE_LABELS.user;
  if (role === 'self') return ENTITY_ROLE_LABELS.self;
  const kind = entityKindKey(node);
  if (kind) return ENTITY_KIND_LABELS[kind] || ENTITY_KIND_LABELS.other;
  if (role) return ENTITY_ROLE_LABELS[role] || role;
  return ENTITY_KIND_LABELS.other;
}

function entityRoleLabel(role?: string): string {
  const key = String(role ?? '').trim().toLowerCase();
  if (!key) return '—';
  return ENTITY_ROLE_LABELS[key] || key;
}

function formatDateLabel(value?: string | null): string {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (dateOnly) return dateOnly[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimeWindow(validAt?: string | null, invalidAt?: string | null): string {
  const from = formatDateLabel(validAt);
  const to = formatDateLabel(invalidAt);
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '';
}

function buildRelatedFacts(node: GraphNode): RelatedFact[] {
  return links.value
    .filter((link) => link.source === node.id || link.target === node.id)
    .map((link) => {
      const isOutgoing = link.source === node.id;
      const peerId = isOutgoing ? link.target : link.source;
      const validAt = link.properties?.validAt ?? link.properties?.valid_at ?? null;
      const invalidAt = link.properties?.invalidAt ?? link.properties?.invalid_at ?? null;
      return {
        relation: link.type || 'RELATED',
        description: String(link.properties?.description || '').trim(),
        peerLabel: nodeLabelById(peerId),
        timeLabel: formatTimeWindow(validAt, invalidAt),
      };
    });
}

function buildEntityDetail(node: GraphNode): EntityDetail {
  const role = entityRoleKey(node);
  const kind = entityKindKey(node);
  const typeLabel = node.type === 'Seed'
    ? '种子'
    : node.type === 'Stream'
      ? '意识流'
      : node.type === 'Entity'
        ? entityTypeLabel(node)
        : '实体';
  return {
    id: node.id,
    nodeKind: node.type === 'Thread' ? 'Thread' : 'Entity',
    name: node.properties.name || node.label,
    entityType: typeLabel,
    role: role || undefined,
    kind: kind || undefined,
    narrative: node.properties.narrative || node.properties.summary || '暂无描述',
    createdAt: node.properties.created_at || null,
    validAt: node.properties.valid_at ?? null,
    invalidAt: node.properties.invalid_at ?? null,
    relatedFacts: buildRelatedFacts(node),
  };
}

function buildThreadDetail(node: GraphNode): EntityDetail {
  return {
    id: node.id,
    nodeKind: 'Thread',
    name: node.properties.title || node.label,
    entityType: '心事线',
    narrative: node.properties.last_note || '暂无最新备注',
    createdAt: node.properties.created_at || null,
    updatedAt: node.properties.updated_at || null,
    status: node.properties.status,
    currentGrip: node.properties.current_grip,
    relatedFacts: buildRelatedFacts(node),
  };
}

function renderChart() {
  if (!chart) return;
  const visibleNodes = nodes.value.filter((node) => isNodeVisible(node.nodeClass));
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const graphNodes = visibleNodes.map((node) => {
    const role = entityRoleKey(node);
    const isUserEntity = role === 'user' || node.nodeClass === 'entity-user';
    const isThread = node.type === 'Thread';
    const isMemory = node.type === 'Seed' || node.type === 'Stream';
    const radius = isUserEntity ? 26 : isThread ? 22 : isMemory ? 12 : 18;
    return {
      id: node.id,
      name: node.label,
      symbolSize: radius,
      itemStyle: { color: nodeColor(node.nodeClass) },
      category: node.nodeClass,
      raw: node,
    };
  });
  const graphLinks = links.value.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target)).map((link) => ({
    source: link.source,
    target: link.target,
    label: {
      show: true,
      formatter: link.type || '',
      fontSize: 10,
      color: 'rgba(255, 255, 255, 0.45)',
    },
    lineStyle: {
      color: 'rgba(255, 255, 255, 0.15)',
      width: 1,
      curveness: 0.15,
    },
  }));

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      confine: true,
      backgroundColor: 'rgba(28, 28, 28, 0.95)',
      borderColor: 'var(--border-color, rgba(255,255,255,0.15))',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: {
        color: 'var(--text-primary, #e5e5e5)',
        fontSize: 12,
      },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.35); border-radius: 8px; max-width: 280px; white-space: normal; word-break: break-all;',
      formatter: (params: { data?: { raw?: GraphNode } }) => {
        const raw = params.data?.raw;
        if (!raw) return '';
        const kindLabel = raw.type === 'Thread' ? '心事线'
          : raw.type === 'Seed' ? '种子'
          : raw.type === 'Stream' ? '意识流'
          : raw.type === 'Entity' ? entityTypeLabel(raw)
          : '实体';
        const title = `[${kindLabel}] ${raw.properties.title || raw.properties.name || raw.label}`;
        const text = raw.type === 'Thread'
          ? raw.properties.last_note || ''
          : raw.properties.narrative || raw.properties.summary || '';
        return `<div style="font-weight: 600; color: var(--primary-color, #3d8c41); margin-bottom: 4px;">${title}</div>` +
               `<div style="line-height: 1.5; color: var(--text-primary, #e5e5e5);">${text}</div>`;
      },
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      data: graphNodes,
      links: graphLinks,
      force: { repulsion: 180, edgeLength: [80, 160] },
      label: { show: false },
      emphasis: { focus: 'adjacency' },
    }],
  });

  chart.off('click');
  chart.on('click', (params: any) => {
    const raw = params.data?.raw as GraphNode | undefined;
    if (!raw) return;
    selectedId.value = raw.id;
    detail.value = raw.type === 'Thread' ? buildThreadDetail(raw) : buildEntityDetail(raw);
  });
}

async function loadGraph() {
  loading.value = true;
  errorText.value = '';
  selectedId.value = null;
  detail.value = null;
  try {
    const params = memoryQueryParams({ limit: 200 });
    const res = await fetch(getFullUrl(`/api/v1/memory/graph?${params}&mode=entity`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    nodes.value = Array.isArray(data.nodes) ? data.nodes : [];
    links.value = Array.isArray(data.links) ? data.links : [];
    renderChart();
    applySearchAndFocus();
  } catch (error) {
    errorText.value = (error as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

function onResize() {
  chart?.resize();
}

watch(agentFilter, () => { void loadGraph(); });
watch(() => route.query, () => { applySearchAndFocus(); });

onMounted(() => {
  if (chartRef.value) {
    chart = echarts.init(chartRef.value);
    window.addEventListener('resize', onResize);
  }
  void loadGraph();
});

// keep-alive 切回本 tab 时画布刚从缓存取出，补一次尺寸校正。
onActivated(() => {
  chart?.resize();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="memory-graph-view">
    <div class="graph-toolbar">
      <div class="legend">
        <button
          v-for="group in LEGEND"
          :key="group.key"
          type="button"
          class="legend-chip"
          :class="{ off: isGroupHidden(group.key) }"
          :title="isGroupHidden(group.key) ? '点击显示' : '点击隐藏'"
          @click="toggleGroup(group.key)"
        >
          <i class="dot" :class="group.sample" />{{ group.label }}
        </button>
      </div>
      <AInput
        v-model="searchText"
        class="search-input"
        placeholder="搜索实体 / 心事线…"
        allow-clear
        @press-enter="runSearch"
        @clear="runSearch"
      />
    </div>

    <div class="main-content-layout">
    <!-- Left Column: Graph Visualizer -->
    <div class="graph-shell">
      <div v-if="loading" class="overlay">加载中…</div>
      <div v-if="errorText" class="overlay error">{{ errorText }}</div>
      <div ref="chartRef" class="chart" />
    </div>

    <!-- Right Column: Fixed Detail Panel -->
    <aside class="detail-panel">
      <header class="panel-header">
        <h3>实体详情</h3>
      </header>
      <div v-if="!selectedId || !detail" class="panel-placeholder">
        <div class="placeholder-icon">👁️‍🗨️</div>
        <p class="placeholder-title">未选中实体节点</p>
        <p class="placeholder-desc">
          点击左侧图谱中的实体或心事线，查看描述与关联事实。数据来自 SQLite（Entity / Fact / Thread）。
        </p>
      </div>
      <div v-else class="panel-body">
        <div class="about-tag">
          <span class="type-badge entity">{{ detail.nodeKind === 'Thread' ? '心事线' : '实体' }}: {{ detail.entityType }}</span>
          <span class="about-path">{{ detail.name }}</span>
        </div>

        <div class="panel-section">
          <h4 class="section-title">描述</h4>
          <p class="narrative-text">{{ detail.narrative }}</p>
        </div>

        <div class="panel-section">
          <h4 class="section-title">实体信息</h4>
          <dl class="meta-list">
            <div class="meta-row"><dt>实体名称</dt><dd>{{ detail.name }}</dd></div>
            <div class="meta-row"><dt>类型</dt><dd class="mono">{{ detail.entityType }}</dd></div>
            <div v-if="detail.nodeKind !== 'Thread'" class="meta-row"><dt>角色</dt><dd class="mono">{{ entityRoleLabel(detail.role) }}</dd></div>
            <div v-if="detail.nodeKind !== 'Thread' && (detail.validAt || detail.invalidAt)" class="meta-row"><dt>有效时间</dt><dd class="time-label">{{ formatTimeWindow(detail.validAt, detail.invalidAt) }}</dd></div>
            <div v-if="detail.nodeKind === 'Thread'" class="meta-row"><dt>状态</dt><dd class="mono">{{ ['open', 'active', 'candidate'].includes(String(detail.status || '').toLowerCase()) ? '还在心上' : '已放下' }}</dd></div>
            <div v-if="detail.nodeKind === 'Thread'" class="meta-row"><dt>占据度</dt><dd class="mono">{{ detail.currentGrip != null ? Math.round((detail.currentGrip as number) * 100) + '%' : '—' }}</dd></div>
            <div class="meta-row"><dt>记录时间</dt><dd class="time-label">{{ detail.createdAt || '—' }}</dd></div>
            <div v-if="detail.updatedAt" class="meta-row"><dt>更新时间</dt><dd class="time-label">{{ detail.updatedAt }}</dd></div>
          </dl>
        </div>

        <div v-if="detail.relatedFacts.length" class="panel-section">
          <h4 class="section-title">关联事实</h4>
          <ul class="fact-list">
            <li v-for="(fact, index) in detail.relatedFacts" :key="index">
              <span class="fact-relation">{{ fact.relation }}</span>
              <span class="fact-peer">{{ fact.peerLabel }}</span>
              <p v-if="fact.description" class="fact-desc">{{ fact.description }}</p>
              <p v-if="fact.timeLabel" class="fact-time">{{ fact.timeLabel }}</p>
            </li>
          </ul>
        </div>
      </div>
    </aside>
  </div>
  </div>
</template>

<style scoped>
.memory-graph-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px 24px 24px;
  color: var(--text-primary);
}

.graph-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.search-input {
  width: min(280px, 100%);
  flex: none;
}

.legend {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.legend-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}
.legend-chip.off { opacity: 0.4; text-decoration: line-through; }
.legend-chip:hover { border-color: var(--text-secondary); }

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
}

.dot.user { background: #3b82f6; }
.dot.us { background: #10b981; }
.dot.self { background: #f43f5e; }
.dot.entity-user { background: #3b82f6; }
.dot.entity-person { background: #f97316; }
.dot.entity-location { background: #10b981; }
.dot.entity-organization { background: #0ea5e9; }
.dot.entity-concept { background: #14b8a6; }
.dot.entity-pet { background: #eab308; }
.dot.entity-other { background: #a855f7; }
.dot.thread-open { background: #ef4444; }
.dot.thread-closed { background: #64748b; }
.dot.seed { background: #22d3ee; }
.dot.stream { background: #94a3b8; }

.main-content-layout {
  display: flex;
  flex-direction: row;
  gap: 16px;
  flex: 1;
  min-height: 0;
  align-items: stretch;
}

.graph-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  overflow: hidden;
}

.chart {
  width: 100%;
  height: 100%;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
  z-index: 2;
  font-size: 14px;
}

.overlay.error {
  color: var(--color-error, #f53f3f);
}

/* ── Fixed Detail Panel Styles ── */
.detail-panel {
  width: 350px;
  flex-shrink: 0;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
}

.panel-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.panel-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
  gap: 8px;
}

.placeholder-icon {
  font-size: 32px;
  opacity: 0.6;
}

.placeholder-title {
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 2px;
  color: var(--text-secondary);
}

.placeholder-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary);
  max-width: 220px;
}

.panel-body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.about-tag {
  display: flex;
  align-items: center;
  gap: 8px;
}

.type-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-hover, rgba(0,0,0,0.04));
  color: var(--text-primary);
  border: 1px solid var(--border-color, rgba(0,0,0,0.1));
  flex-shrink: 0;
}

.type-badge.user {
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.2);
}

.type-badge.us {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.2);
}

.type-badge.self {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.1);
  border-color: rgba(244, 63, 94, 0.2);
}

.type-badge.entity {
  color: #14b8a6;
  background: rgba(20, 184, 166, 0.1);
  border-color: rgba(20, 184, 166, 0.2);
}

.about-path {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
  word-break: break-all;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.narrative-text {
  margin: 0;
  line-height: 1.55;
  font-size: 13px;
  color: var(--text-primary);
}

.fact-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.fact-list li {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-hover, rgba(0,0,0,0.03));
  border: 1px solid var(--border-color, rgba(0,0,0,0.08));
}

.fact-relation {
  display: inline-block;
  margin-right: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary-color);
}

.fact-peer {
  font-size: 12px;
  color: var(--text-primary);
}

.fact-desc {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.fact-time {
  margin: 4px 0 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-tertiary);
}

/* Metadata lists */
.meta-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  background: var(--bg-hover, rgba(0,0,0,0.02));
  border: 1px solid var(--border-color, rgba(0,0,0,0.06));
  padding: 10px 14px;
  border-radius: 8px;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.meta-row dt {
  color: var(--text-secondary);
}

.meta-row dd {
  margin: 0;
  color: var(--text-primary);
  font-weight: 500;
}

.meta-row dd.mono {
  font-family: monospace;
}

.meta-row dd.time-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.ghost-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

</style>
