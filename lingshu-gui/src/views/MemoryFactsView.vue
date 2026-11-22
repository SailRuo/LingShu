<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMemoryApiContext } from '../composables/useMemoryApiContext';
import { useMemoryPageFilter } from '../composables/useMemoryPageFilter';

interface FactItem {
  id: string;
  sourceId: string;
  sourceName: string;
  targetId: string | null;
  targetName: string;
  relation: string;
  description: string;
  confidence: number;
  status: string;
  importance: number;
  isIdentity: boolean;
  evidence: unknown;
  createdAt: string;
  expiredAt: string | null;
  validAt: string | null;
  invalidAt: string | null;
  sourceEpisodeId: string | null;
  cardinality: string;
  supersededByFactId: string | null;
  invalidationReason: string | null;
  updatedAt: string | null;
}

interface FactSourceItem {
  factId: string;
  episodeId: string;
  streamId: string | null;
  evidenceQuote: string | null;
  createdAt: string;
  episode: {
    id: string;
    source: string;
    sourceDescription: string | null;
    threadId: number | null;
    startedAt: string;
    endedAt: string;
    referenceTime: string;
    rawExcerpt: string;
    messageIds: number[];
  };
}

interface MemoryHealth {
  ftsReady: boolean;
  ftsRowsForScope: number;
  facts: {
    total: number;
    current: number;
    expired: number;
  };
  digest: {
    lastStatus: string | null;
    lastAt: string | null;
    failedRecent: number;
    pending: number;
    running: number;
  };
}

const STATUS_FILTERS = [
  { value: 'current', label: '当前' },
  { value: 'expired', label: '已过期' },
  { value: 'all', label: '全部' },
] as const;

type FactStatusFilter = (typeof STATUS_FILTERS)[number]['value'];

const RELATION_LABELS: Record<string, string> = {
  HAS_NAME: '名字',
  AGE: '年龄',
  GENDER: '性别',
  LIVES_IN: '居住地',
  OCCUPATION: '职业',
  SLEEP_PATTERN: '睡眠习惯',
  HAS_WORK_PATTERN: '工作习惯',
  LIKES: '喜欢',
  DISLIKES: '不喜欢',
  HAS_PET: '宠物',
  HAS_FRIEND: '朋友',
  HAS_FAMILY: '家人',
  INTERESTED_IN: '兴趣',
  HAS_HEALTH_CONDITION: '健康状况',
  HAS_BODY_REACTION: '身体反应',
  HAS_ROUTINE: '日常习惯',
  WORKS_AT: '工作于',
  LIVES_WITH: '同住',
};

const INVALIDATION_REASON_LABELS: Record<string, string> = {
  contradicted: '被新事实推翻',
  source_deleted: '来源对话已删除',
  out_of_order: '乱序到达的旧事',
  migration_dedupe: '迁移去重',
  manual_forget: '手动遗忘',
  ttl: '到期失效',
};

const DIGEST_STATUS_LABELS: Record<string, string> = {
  done: '成功',
  success: '成功',
  failed: '失败',
  running: '运行中',
  pending: '等待中',
  stale: '已跳过',
  skipped: '已跳过',
};

const EPISODE_SOURCE_LABELS: Record<string, string> = {
  chat: '对话',
  voice: '语音',
  call: '通话',
  import: '导入',
};

const agentFilter = useMemoryPageFilter();
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const statusFilter = ref<FactStatusFilter>('current');
const asOfDate = ref('');
const loading = ref(false);
const errorText = ref('');
const items = ref<FactItem[]>([]);
const total = ref(0);
const selectedFactId = ref<string | null>(null);
const sources = ref<FactSourceItem[]>([]);
const sourcesLoading = ref(false);
const sourcesError = ref('');

const health = ref<MemoryHealth | null>(null);
const healthLoading = ref(false);
const healthError = ref('');

let factsRequestSeq = 0;
let sourcesRequestSeq = 0;
let healthRequestSeq = 0;

const selectedFact = computed(() => items.value.find((item) => item.id === selectedFactId.value) || null);

function hasAgentScope(): boolean {
  return Number.isFinite(Number(agentFilter.value)) && Number(agentFilter.value) > 0;
}

const listSummary = computed(() => {
  if (loading.value) return '加载中…';
  if (errorText.value) return '加载失败';
  const shown = items.value.length;
  if (asOfDate.value) return `${asOfDate.value}（UTC）当时有效 · ${shown} 条`;
  if (shown < total.value) return `共 ${total.value} 条 · 显示 ${shown} 条`;
  return `共 ${total.value} 条`;
});

function relationLabel(relation: string): string {
  const key = String(relation || '').trim().toUpperCase();
  return RELATION_LABELS[key] || relation;
}

function invalidationReasonLabel(reason: string): string {
  return INVALIDATION_REASON_LABELS[reason] || reason;
}

function digestStatusLabel(status?: string | null): string {
  if (!status) return '无';
  return DIGEST_STATUS_LABELS[status] || status;
}

function digestTone(): string {
  const status = health.value?.digest.lastStatus;
  if (!status) return 'muted';
  if (status === 'done' || status === 'success') return 'ok';
  if (status === 'failed') return 'bad';
  return 'muted';
}

function episodeSourceLabel(source?: string | null): string {
  const key = String(source || '').trim().toLowerCase();
  if (!key) return '未知来源';
  return EPISODE_SOURCE_LABELS[key] || String(source);
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const text = String(value).trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (dateOnly) return dateOnly[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function displayDateTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

function formatTimeWindow(fact: FactItem): string {
  const from = formatDate(fact.validAt || fact.createdAt);
  const to = formatDate(fact.invalidAt);
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '—';
}

function formatEpisodeRange(start?: string | null, end?: string | null): string {
  const from = formatDateTime(start);
  const to = formatDateTime(end);
  if (from && to) return from === to ? from : `${from} ~ ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '—';
}

function formatScore(value?: number | null): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (num >= 0 && num <= 1) return `${Math.round(num * 100)}%`;
  return String(Math.round(num));
}

function factStatusLabel(fact: FactItem): string {
  if (asOfDate.value) return '历史';
  if (fact.status === 'current') return '当前';
  if (fact.status === 'expired') return '已过期';
  return fact.status || '未知';
}

function factStatusClass(fact: FactItem): string {
  if (asOfDate.value) return 'historical';
  if (fact.status === 'current') return 'current';
  if (fact.status === 'expired') return 'expired';
  return 'unknown';
}

function storedStatusLabel(fact: FactItem): string {
  if (fact.status === 'current') return '当前';
  if (fact.status === 'expired') return '已过期';
  return fact.status || '未知';
}

function compareFacts(a: FactItem, b: FactItem): number {
  const importanceDiff = (Number(b.importance) || 0) - (Number(a.importance) || 0);
  if (importanceDiff !== 0) return importanceDiff;
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

interface FactsPage {
  items: FactItem[];
  total: number;
}

async function fetchFactsPage(options: { status?: string; asOf?: string }): Promise<FactsPage> {
  const params = memoryQueryParams({
    limit: 200,
    status: options.status,
    asOf: options.asOf,
  });
  const res = await fetch(getFullUrl(`/api/v1/memory/facts?${params}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pageItems = Array.isArray(data.items) ? (data.items as FactItem[]) : [];
  const pageTotal = Number(data.total);
  return {
    items: pageItems,
    total: Number.isFinite(pageTotal) ? pageTotal : pageItems.length,
  };
}

function clearSelection() {
  selectedFactId.value = null;
  sources.value = [];
  sourcesError.value = '';
  sourcesLoading.value = false;
  sourcesRequestSeq += 1;
}

async function loadFacts() {
  if (!hasAgentScope()) {
    items.value = [];
    total.value = 0;
    loading.value = false;
    errorText.value = '';
    clearSelection();
    return;
  }
  const seq = ++factsRequestSeq;
  loading.value = true;
  errorText.value = '';
  clearSelection();
  try {
    let nextItems: FactItem[];
    let nextTotal: number;
    if (asOfDate.value) {
      const page = await fetchFactsPage({ asOf: `${asOfDate.value}T00:00:00.000Z` });
      nextItems = page.items;
      nextTotal = page.total;
    } else if (statusFilter.value === 'all') {
      // The backend treats `status` literally (no "all" value), so an
      // unfiltered view is the union of the two lifecycle buckets.
      const [currentPage, expiredPage] = await Promise.all([
        fetchFactsPage({ status: 'current' }),
        fetchFactsPage({ status: 'expired' }),
      ]);
      const merged = new Map<string, FactItem>();
      for (const item of [...currentPage.items, ...expiredPage.items]) merged.set(item.id, item);
      nextItems = [...merged.values()].sort(compareFacts);
      nextTotal = currentPage.total + expiredPage.total;
    } else {
      const page = await fetchFactsPage({ status: statusFilter.value });
      nextItems = page.items;
      nextTotal = page.total;
    }
    if (seq !== factsRequestSeq) return;
    items.value = nextItems;
    total.value = nextTotal;
  } catch (error) {
    if (seq !== factsRequestSeq) return;
    items.value = [];
    total.value = 0;
    errorText.value = (error as Error).message || '加载失败';
  } finally {
    if (seq === factsRequestSeq) loading.value = false;
  }
}

async function loadHealth() {
  if (!hasAgentScope()) {
    health.value = null;
    healthLoading.value = false;
    healthError.value = '';
    return;
  }
  const seq = ++healthRequestSeq;
  healthLoading.value = true;
  healthError.value = '';
  try {
    const res = await fetch(getFullUrl(`/api/v1/memory/health?${memoryQueryParams()}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== healthRequestSeq) return;
    health.value = data as MemoryHealth;
  } catch {
    if (seq !== healthRequestSeq) return;
    healthError.value = '记忆健康信息不可用';
  } finally {
    if (seq === healthRequestSeq) healthLoading.value = false;
  }
}

async function refreshAll() {
  await Promise.all([loadFacts(), loadHealth()]);
}

async function loadSources(factId: string) {
  const seq = ++sourcesRequestSeq;
  sourcesLoading.value = true;
  sourcesError.value = '';
  sources.value = [];
  try {
    const params = memoryQueryParams();
    const res = await fetch(
      getFullUrl(`/api/v1/memory/facts/${encodeURIComponent(factId)}/sources?${params}`),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== sourcesRequestSeq || selectedFactId.value !== factId) return;
    sources.value = Array.isArray(data.items) ? (data.items as FactSourceItem[]) : [];
  } catch (error) {
    if (seq !== sourcesRequestSeq || selectedFactId.value !== factId) return;
    sourcesError.value = (error as Error).message || '来源加载失败';
  } finally {
    if (seq === sourcesRequestSeq) sourcesLoading.value = false;
  }
}

function selectFact(fact: FactItem) {
  if (selectedFactId.value === fact.id) {
    clearSelection();
    return;
  }
  selectedFactId.value = fact.id;
  void loadSources(fact.id);
}

function pickStatus(value: FactStatusFilter) {
  statusFilter.value = value;
  if (asOfDate.value) asOfDate.value = '';
}

function closeDetail() {
  clearSelection();
}

watch(agentFilter, (value) => {
  if (Number(value) > 0) void refreshAll();
}, { immediate: true });
watch([statusFilter, asOfDate], () => { void loadFacts(); });
</script>

<template>
  <div class="memory-facts-view">
    <section class="health-strip">
      <span v-if="healthError && !health" class="health-pill bad">{{ healthError }}</span>
      <span v-else-if="!hasAgentScope()" class="health-pill muted">先选择一个角色</span>
      <span v-else-if="!health" class="health-pill muted">记忆健康加载中…</span>
      <template v-if="health">
        <span class="health-pill" :class="health.ftsReady ? 'ok' : 'bad'">
          <i class="health-dot" />
          FTS {{ health.ftsReady ? '可用' : '不可用' }}
          <em v-if="health.ftsReady">{{ health.ftsRowsForScope }} 行</em>
        </span>
        <span class="health-pill">
          当前事实 <strong>{{ health.facts.current }}</strong>
        </span>
        <span class="health-pill">
          过期 <strong>{{ health.facts.expired }}</strong>
        </span>
        <span class="health-pill" :class="digestTone()">
          最近 digest
          <strong>{{ digestStatusLabel(health.digest.lastStatus) }}</strong>
          <em v-if="health.digest.lastAt">{{ displayDateTime(health.digest.lastAt) }}</em>
        </span>
        <span class="health-pill" :class="{ bad: health.digest.failedRecent > 0 }">
          24h 失败 <strong>{{ health.digest.failedRecent }}</strong>
        </span>
        <span v-if="health.digest.pending || health.digest.running" class="health-pill muted">
          排队 {{ health.digest.pending }} · 运行 {{ health.digest.running }}
        </span>
        <span v-if="healthError" class="health-pill bad">刷新失败</span>
      </template>
    </section>

    <section class="facts-toolbar">
      <div class="status-chips">
        <span class="chip-label">状态</span>
        <button
          v-for="option in STATUS_FILTERS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ active: !asOfDate && statusFilter === option.value }"
          @click="pickStatus(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <label class="date-field">
        按天查看
        <input v-model="asOfDate" type="date" />
      </label>
      <span class="date-hint">{{ asOfDate ? '按 UTC 日期 · 世界当时有效' : '选择日期后忽略状态筛选' }}</span>
      <button v-if="asOfDate" type="button" class="ghost-btn" @click="asOfDate = ''">清除日期</button>
      <button type="button" class="refresh-btn" :disabled="loading || healthLoading" @click="refreshAll">
        {{ loading || healthLoading ? '刷新中…' : '刷新' }}
      </button>
    </section>

    <div class="facts-layout">
      <section class="list-panel">
        <header class="list-header">
          <span>{{ listSummary }}</span>
          <span v-if="asOfDate" class="list-mode">历史视图</span>
        </header>
        <div class="list-scroll">
          <div v-if="loading" class="state-box">加载中…</div>
          <div v-else-if="errorText" class="state-box error">
            <p>{{ errorText }}</p>
            <button type="button" class="ghost-btn" @click="loadFacts">重试</button>
          </div>
          <div v-else-if="!items.length" class="state-box">
            {{ asOfDate ? '这个日期没有当时有效的事实' : (hasAgentScope() ? '暂无事实' : '先选择一个角色') }}
          </div>
          <template v-else>
            <article
              v-for="fact in items"
              :key="fact.id"
              class="fact-row"
              :class="{ selected: selectedFactId === fact.id }"
              role="button"
              tabindex="0"
              @click="selectFact(fact)"
              @keydown.enter="selectFact(fact)"
              @keydown.space.prevent="selectFact(fact)"
            >
              <div class="fact-row-head">
                <span class="fact-subject">{{ fact.sourceName }}</span>
                <span class="fact-sep">·</span>
                <span class="fact-relation">{{ relationLabel(fact.relation) }}</span>
                <template v-if="fact.targetName">
                  <span class="fact-arrow">→</span>
                  <span class="fact-target">{{ fact.targetName }}</span>
                </template>
                <span class="status-badge" :class="factStatusClass(fact)">{{ factStatusLabel(fact) }}</span>
              </div>
              <p class="fact-description">{{ fact.description }}</p>
              <div class="fact-meta">
                <span class="fact-window">{{ formatTimeWindow(fact) }}</span>
                <span>置信 {{ formatScore(fact.confidence) }}</span>
                <span>重要 {{ formatScore(fact.importance) }}</span>
                <span v-if="fact.isIdentity" class="identity-tag">身份事实</span>
              </div>
              <div v-if="fact.supersededByFactId || fact.invalidationReason" class="fact-flags">
                <span v-if="fact.supersededByFactId" class="fact-flag">已被新事实取代</span>
                <span v-if="fact.invalidationReason" class="fact-flag muted">
                  {{ invalidationReasonLabel(fact.invalidationReason) }}
                </span>
              </div>
            </article>
          </template>
        </div>
      </section>

      <aside class="detail-panel">
        <header class="panel-header">
          <h3>事实详情</h3>
          <button v-if="selectedFact" type="button" class="ghost-btn" @click="closeDetail">关闭</button>
        </header>
        <div v-if="!selectedFact" class="panel-placeholder">
          <div class="placeholder-icon">🗂️</div>
          <p class="placeholder-title">未选中事实</p>
          <p class="placeholder-desc">点击左侧一条事实，查看它的来源证据、原话与对话时间。</p>
        </div>
        <div v-else class="panel-body">
          <div class="detail-title">
            <span class="fact-subject">{{ selectedFact.sourceName }}</span>
            <span class="fact-sep">·</span>
            <span class="fact-relation">{{ relationLabel(selectedFact.relation) }}</span>
            <template v-if="selectedFact.targetName">
              <span class="fact-arrow">→</span>
              <span class="fact-target">{{ selectedFact.targetName }}</span>
            </template>
          </div>
          <div class="detail-status-line">
            <span class="status-badge" :class="factStatusClass(selectedFact)">{{ factStatusLabel(selectedFact) }}</span>
            <span v-if="selectedFact.supersededByFactId" class="fact-flag">已被新事实取代</span>
          </div>
          <p class="detail-description">{{ selectedFact.description }}</p>

          <dl class="meta-list">
            <div v-if="asOfDate" class="meta-row">
              <dt>库内状态</dt>
              <dd>{{ storedStatusLabel(selectedFact) }}</dd>
            </div>
            <div class="meta-row">
              <dt>有效时间</dt>
              <dd>{{ formatTimeWindow(selectedFact) }}</dd>
            </div>
            <div class="meta-row">
              <dt>创建时间</dt>
              <dd>{{ displayDateTime(selectedFact.createdAt) }}</dd>
            </div>
            <div v-if="selectedFact.expiredAt" class="meta-row">
              <dt>过期时间</dt>
              <dd>{{ displayDateTime(selectedFact.expiredAt) }}</dd>
            </div>
            <div v-if="selectedFact.updatedAt" class="meta-row">
              <dt>更新时间</dt>
              <dd>{{ displayDateTime(selectedFact.updatedAt) }}</dd>
            </div>
            <div class="meta-row">
              <dt>置信 / 重要</dt>
              <dd>{{ formatScore(selectedFact.confidence) }} / {{ formatScore(selectedFact.importance) }}</dd>
            </div>
            <div v-if="selectedFact.invalidationReason" class="meta-row">
              <dt>失效原因</dt>
              <dd>{{ invalidationReasonLabel(selectedFact.invalidationReason) }}</dd>
            </div>
            <div v-if="selectedFact.supersededByFactId" class="meta-row">
              <dt>取代事实</dt>
              <dd class="mono">{{ selectedFact.supersededByFactId }}</dd>
            </div>
            <div v-if="selectedFact.sourceEpisodeId" class="meta-row">
              <dt>来源 Episode</dt>
              <dd class="mono">{{ selectedFact.sourceEpisodeId }}</dd>
            </div>
            <div class="meta-row">
              <dt>事实 ID</dt>
              <dd class="mono">{{ selectedFact.id }}</dd>
            </div>
          </dl>

          <section class="panel-section">
            <h4 class="section-title">
              来源证据
              <span v-if="sources.length" class="section-count">{{ sources.length }}</span>
            </h4>
            <div v-if="sourcesLoading" class="section-state">来源加载中…</div>
            <div v-else-if="sourcesError" class="section-state error">
              {{ sourcesError }}
              <button type="button" class="ghost-btn" @click="loadSources(selectedFact.id)">重试</button>
            </div>
            <div v-else-if="!sources.length" class="section-state">无来源记录（可能是旧数据）</div>
            <div v-else class="source-list">
              <article v-for="(source, index) in sources" :key="`${source.episodeId}-${index}`" class="source-card">
                <div class="source-head">
                  <span class="source-index">#{{ index + 1 }}</span>
                  <span class="source-kind">{{ episodeSourceLabel(source.episode.source) }}</span>
                  <span class="source-recorded">记录于 {{ displayDateTime(source.createdAt) }}</span>
                </div>

                <blockquote v-if="source.evidenceQuote" class="evidence-quote">
                  {{ source.evidenceQuote }}
                </blockquote>
                <p v-else class="evidence-missing">无原话摘录</p>

                <div class="source-section">
                  <span class="source-label">原文摘要</span>
                  <p class="raw-excerpt">{{ source.episode.rawExcerpt || '（无原文）' }}</p>
                </div>

                <dl class="meta-list compact">
                  <div class="meta-row">
                    <dt>对话时间</dt>
                    <dd>{{ formatEpisodeRange(source.episode.startedAt, source.episode.endedAt) }}</dd>
                  </div>
                  <div v-if="source.episode.sourceDescription" class="meta-row">
                    <dt>来源说明</dt>
                    <dd>{{ source.episode.sourceDescription }}</dd>
                  </div>
                  <div v-if="source.episode.threadId != null" class="meta-row">
                    <dt>会话</dt>
                    <dd class="mono">#{{ source.episode.threadId }}</dd>
                  </div>
                  <div class="meta-row">
                    <dt>消息</dt>
                    <dd class="message-ids">
                      <template v-if="source.episode.messageIds.length">
                        <span v-for="messageId in source.episode.messageIds" :key="messageId" class="message-id">
                          #{{ messageId }}
                        </span>
                      </template>
                      <span v-else>—</span>
                    </dd>
                  </div>
                </dl>
              </article>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.memory-facts-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 16px 24px 24px;
  color: var(--text-primary);
  overflow: hidden;
}

.health-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.health-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.health-pill strong {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.health-pill em {
  color: var(--text-tertiary);
  font-style: normal;
  font-size: 11px;
}

.health-pill.ok {
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.08);
}

.health-pill.ok strong {
  color: #10b981;
}

.health-pill.bad {
  border-color: rgba(245, 63, 63, 0.3);
  background: rgba(245, 63, 63, 0.08);
  color: #f53f3f;
}

.health-pill.bad strong {
  color: #f53f3f;
}

.health-pill.muted {
  opacity: 0.75;
}

.health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
}

.health-pill.bad .health-dot {
  background: #f53f3f;
}

.facts-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.status-chips {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chip-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.chip {
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}

.chip.active {
  border-color: var(--primary-color, #3d8c41);
  color: var(--primary-color, #3d8c41);
  background: color-mix(in srgb, var(--primary-color, #3d8c41) 12%, transparent);
}

.date-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.date-field input {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--text-primary);
  font-size: 12px;
  color-scheme: light;
}

:global([data-theme='dark'] .date-field input) {
  color-scheme: dark;
}

.date-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.refresh-btn {
  margin-left: auto;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ghost-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
}

.ghost-btn:hover {
  color: var(--text-primary);
}

.facts-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.list-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  overflow: hidden;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  font-size: 12px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.list-mode {
  color: var(--primary-color, #3d8c41);
}

.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.state-box {
  padding: 40px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.state-box.error {
  color: #f53f3f;
}

.state-box p {
  margin: 0 0 8px;
}

.fact-row {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.07));
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  outline: none;
}

.fact-row:hover {
  border-color: color-mix(in srgb, var(--primary-color, #3d8c41) 30%, transparent);
  background: rgba(255, 255, 255, 0.03);
}

.fact-row:focus-visible {
  border-color: var(--primary-color, #3d8c41);
}

.fact-row.selected {
  border-color: color-mix(in srgb, var(--primary-color, #3d8c41) 45%, transparent);
  background: color-mix(in srgb, var(--primary-color, #3d8c41) 8%, transparent);
}

.fact-row-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 13px;
}

.fact-subject {
  font-weight: 600;
  color: var(--text-primary);
}

.fact-sep {
  color: var(--text-tertiary);
}

.fact-relation {
  color: var(--primary-color, #3d8c41);
  font-weight: 600;
}

.fact-arrow {
  color: var(--text-tertiary);
}

.fact-target {
  color: var(--text-primary);
}

.status-badge {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid transparent;
  white-space: nowrap;
}

.status-badge.current {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.25);
}

.status-badge.expired {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.25);
}

.status-badge.historical {
  color: #60a5fa;
  background: rgba(96, 165, 250, 0.1);
  border-color: rgba(96, 165, 250, 0.25);
}

.status-badge.unknown {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
}

.fact-description {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.fact-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.fact-window {
  font-family: ui-monospace, monospace;
}

.identity-tag {
  color: #a78bfa;
}

.fact-flags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.fact-flag {
  font-size: 11px;
  color: #f59e0b;
}

.fact-flag.muted {
  color: var(--text-tertiary);
}

.detail-panel {
  width: 360px;
  flex-shrink: 0;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
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
  gap: 8px;
  color: var(--text-tertiary);
}

.placeholder-icon {
  font-size: 30px;
  opacity: 0.6;
}

.placeholder-title {
  margin: 6px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.placeholder-desc {
  margin: 0;
  max-width: 240px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-tertiary);
}

.panel-body {
  flex: 1;
  min-height: 0;
  padding: 16px 18px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 13px;
}

.detail-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-status-line .status-badge {
  margin-left: 0;
}

.detail-description {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-primary);
}

.meta-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
}

.meta-list.compact {
  padding: 8px 10px;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.meta-row dt {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.meta-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-primary);
  word-break: break-word;
}

.mono {
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.section-count {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
  font-size: 10px;
}

.section-state {
  padding: 12px;
  border-radius: 8px;
  border: 1px dashed var(--border-color, rgba(255, 255, 255, 0.12));
  font-size: 12px;
  color: var(--text-tertiary);
}

.section-state.error {
  color: #f53f3f;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.source-card {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.07));
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.source-index {
  color: var(--text-secondary);
  font-weight: 600;
}

.source-kind {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
}

.source-recorded {
  margin-left: auto;
}

.evidence-quote {
  margin: 0;
  padding: 8px 10px;
  border-left: 3px solid color-mix(in srgb, var(--primary-color, #3d8c41) 55%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--primary-color, #3d8c41) 7%, transparent);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.evidence-missing {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

.source-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.raw-excerpt {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
}

.message-ids {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.message-id {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  font-family: ui-monospace, monospace;
  font-size: 10px;
  color: var(--text-secondary);
}

@media (max-width: 1100px) {
  .facts-layout {
    flex-direction: column;
  }

  .detail-panel {
    width: 100%;
    max-height: 46vh;
  }
}
</style>
