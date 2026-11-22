import { computed, type Ref } from 'vue';
import { useAgentsStore } from '../stores/agents';
import { useChatStore } from '../stores/chat';
import { getFullUrl } from '../utils/apiConfig';

export type MemoryAgentScope = 'session';
/** Page-level agent filter: a specific agent id. */
export type MemoryAgentFilter = number;

export function useMemoryApiContext(options?: {
  agentScope?: MemoryAgentScope;
  /** When set, overrides agentScope for API query params (e.g. memory graph page). */
  agentFilter?: Ref<MemoryAgentFilter>;
}) {
  const chatStore = useChatStore();
  const agentsStore = useAgentsStore();

  const userId = computed(() => String(chatStore.userId || 'default_user'));
  const agentId = computed(() => {
    const sessionAgent = chatStore.currentAgentId;
    if (typeof sessionAgent === 'number' && Number.isFinite(sessionAgent) && sessionAgent > 0) {
      return sessionAgent;
    }
    const selected = agentsStore.selectedAgentId;
    if (typeof selected === 'number' && Number.isFinite(selected) && selected > 0) {
      return selected;
    }
    const fallback =
      agentsStore.agents.find((agent) => agent.isDefault) ||
      agentsStore.agents[0];
    return typeof fallback?.id === 'number' && Number.isFinite(fallback.id)
      ? fallback.id
      : 0;
  });

  const scopedAgentId = computed(() => {
    const filter = options?.agentFilter?.value;
    // 0 means "the page has not resolved an agent yet"; never send it to a
    // backend route that requires agentId > 0 (it would answer 400).
    if (typeof filter === 'number' && Number.isFinite(filter) && filter > 0) {
      return filter;
    }
    return agentId.value;
  });

  function applyAgentScopeParams(params: URLSearchParams) {
    params.set('agentId', String(scopedAgentId.value));
  }

  function memoryQueryParams(
    extra?: Record<string, string | number | boolean | null | undefined>,
  ): URLSearchParams {
    const params = new URLSearchParams({
      userId: userId.value,
    });
    applyAgentScopeParams(params);
    if (!extra) return params;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    return params;
  }

  return {
    userId,
    agentId,
    scopedAgentId,
    memoryQueryParams,
    getFullUrl,
  };
}
