/**
 * Node backend SQLite schema.
 *
 * IMPORTANT: this schema is owned by the Node backend. By default the Node
 * service uses its own database file (see config.DB_PATH) and must NOT be
 * pointed at the Python backend's database (which tracks `user_version = 12`)
 * without an explicit migration plan. The schema below is additive on top of
 * the Node versions (currently `user_version = 20`); never share a single file
 * between the two runtimes unless you have verified the version handoff.
 *
 * All changes here must stay backwards compatible: add columns/indexes/tables
 * only, never drop or retype existing ones.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../config.js";
import { tokenize } from "../services/memoryTextRank.js";

let db: Database.Database | null = null;
let vectorExtensionReady = false;
let vectorExtensionError: string | null = null;

/**
 * sqlite-vec is optional at runtime. Callers that claim ANN must consult this
 * status instead of silently assuming the vec0 tables exist.
 */
export function vectorExtensionStatus(): { ready: boolean; error: string | null } {
  return { ready: vectorExtensionReady, error: vectorExtensionError };
}

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = path.resolve(config.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initVectorExtension(db);
  initSchema(db);
  return db;
}

function initVectorExtension(database: Database.Database) {
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(database);
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS stream_vec USING vec0(stream_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_wake_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_boost_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_suppress_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(entity_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_vec USING vec0(fact_id TEXT PRIMARY KEY, embedding float[768]);
    `);
    vectorExtensionReady = true;
    vectorExtensionError = null;
  } catch (error) {
    vectorExtensionReady = false;
    vectorExtensionError = error instanceof Error ? error.message : String(error);
  }
}

const SCHEMA_VERSION = 23;

function initSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar TEXT,
      color TEXT,
      voice TEXT,
      role_setting TEXT,
      speaking_style TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      self_evolution_enabled INTEGER NOT NULL DEFAULT 1,
      time_mirror_enabled INTEGER NOT NULL DEFAULT 1,
      proactive_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings_rows (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT '保密',
      age INTEGER NOT NULL DEFAULT 0,
      bio TEXT NOT NULL DEFAULT '',
      voiceprint_embedding TEXT NOT NULL DEFAULT '',
      voiceprint_sample_count INTEGER NOT NULL DEFAULT 0,
      voiceprint_enabled INTEGER NOT NULL DEFAULT 0,
      voiceprint_threshold REAL NOT NULL DEFAULT 0.65,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      last_message_text TEXT,
      last_message_at TEXT,
      last_message_kind TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_read_message_id INTEGER,
      last_read_at TEXT,
      active_skills TEXT,
      thread_skills TEXT,
      -- Oldest message id the LLM context still starts from. The window is
      -- anchored here and only ever grows, so the request prefix stays
      -- byte-identical between turns and the provider's prompt cache keeps
      -- hitting. It is moved forward rarely (see loadThreadHistory).
      llm_anchor_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, agent_id)
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_threads_user_updated ON chat_threads (user_id, updated_at);`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_kind TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reply_to_message_id INTEGER,
      turn_pair_id INTEGER,
      task_id TEXT,
      user_images_json TEXT,
      assistant_images_json TEXT,
      -- The exact text that was sent to the LLM for this user message (without
      -- the per-turn context), replayed verbatim so the request prefix is
      -- stable. The per-turn context lives in a separate role='system',
      -- message_kind='turn_context' row whose content is the exact text sent.
      llm_content TEXT,
      -- The tool round-trip of the turn, stored verbatim so the next request can
      -- replay it exactly (assistant tool_calls + tool results). Dropping it
      -- changes the request prefix and costs the provider's prompt cache.
      tool_messages_json TEXT,
      input_metadata TEXT,
      assistant_read_at TEXT,
      assistant_unspoken TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT,
      emotional_analysis TEXT,
      retrieved_facts TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      digested_at TEXT,
      purge_at TEXT
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_thread_created ON chat_messages (thread_id, created_at);`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_user_agent_created ON chat_messages (user_id, agent_id, created_at);`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_turn_pair ON chat_messages (turn_pair_id);`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      message_id INTEGER,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      root_event_id TEXT,
      last_event_id TEXT,
      last_checkpoint_id TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      workspace_path TEXT,
      request_text TEXT,
      started_at TEXT NOT NULL,
      interrupted_at TEXT,
      resumed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_task_runs_thread ON task_runs (thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE CASCADE,
      parent_event_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      event_sequence INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      step_status TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      attempt_group_id TEXT,
      branch_id TEXT,
      node_name TEXT,
      error_class TEXT,
      payload_json TEXT,
      error_json TEXT,
      stdout_preview TEXT,
      stderr_preview TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      output_bytes INTEGER,
      output_checksum TEXT,
      artifact_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, event_sequence)
    );
    CREATE INDEX IF NOT EXISTS ix_task_events_task_seq ON task_events (task_id, event_sequence);

    CREATE TABLE IF NOT EXISTS task_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE CASCADE,
      event_sequence INTEGER,
      state_snapshot_json TEXT,
      pending_queue_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, event_sequence)
    );

    CREATE TABLE IF NOT EXISTS mcp_server_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      transport_type TEXT NOT NULL,
      command TEXT,
      args_json TEXT,
      env_json TEXT,
      url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_token_usage_daily (
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension TEXT NOT NULL DEFAULT 'input_uncached',
      input_cached INTEGER NOT NULL DEFAULT 0,
      input_uncached INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0,
      output_cached INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model, dimension)
    );
    CREATE TABLE IF NOT EXISTS tts_usage_daily (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );

    -- Per-call request / response log. The GUI drawer renders it as the
    -- "调用记录" panel: the raw LLM payload plus the provider usage counters
    -- (input cache hit / output cache hit).
    CREATE TABLE IF NOT EXISTS llm_call_traces (
      id TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      tool_name TEXT,
      request_json TEXT,
      response_json TEXT,
      usage_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
      ON llm_call_traces (thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_streams (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      narrative TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'external',
      raw_start INTEGER,
      raw_end INTEGER,
      revisit_count INTEGER NOT NULL DEFAULT 1,
      revisit_last_at TEXT,
      last_proactive_at TEXT,
      significance REAL NOT NULL DEFAULT 0.5,
      archived INTEGER NOT NULL DEFAULT 0,
      cluster_linked_at TEXT,
      origin_scope TEXT,
      perspective TEXT,
      origin_group_session_id TEXT,
      origin_theater_id TEXT,
      participants_json TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_streams_scope ON hippocampus_streams (agent_id, user_id, archived, created_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_seeds (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'about_self',
      source TEXT NOT NULL DEFAULT 'learned',
      tags_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      applicability_json TEXT,
      inner_orientation TEXT NOT NULL DEFAULT '',
      outer_expression TEXT NOT NULL DEFAULT '',
      wake_text TEXT NOT NULL DEFAULT '',
      boost_text TEXT NOT NULL DEFAULT '',
      suppress_text TEXT NOT NULL DEFAULT '',
      innate INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT,
      wake_embedding BLOB,
      boost_embedding BLOB,
      suppress_embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope ON hippocampus_seeds (agent_id, user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_seed_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      seed_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      trigger_source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT,
      session_id INTEGER,
      turn_ids_json TEXT,
      before_json TEXT,
      after_json TEXT,
      field TEXT,
      affect_note TEXT,
      recall_audit_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_seed ON hippocampus_seed_versions (seed_id, version_no DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_entities (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      narrative TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_entities_scope ON hippocampus_entities (agent_id, user_id, name, type);

    CREATE TABLE IF NOT EXISTS hippocampus_facts (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      from_entity_id TEXT,
      to_entity_id TEXT,
      relation TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'current',
      importance REAL NOT NULL DEFAULT 0.5,
      is_identity INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      expired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_hc_facts_scope ON hippocampus_facts (agent_id, user_id, status);

    CREATE TABLE IF NOT EXISTS hippocampus_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      UNIQUE (edge_type, source_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_edges_source ON hippocampus_edges (source_id, edge_type);
    CREATE INDEX IF NOT EXISTS ix_hc_edges_target ON hippocampus_edges (target_id, edge_type);

    CREATE TABLE IF NOT EXISTS hippocampus_threads (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      current_grip REAL,
      last_note TEXT,
      origin_note TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_touchpoints (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      episode_ref TEXT,
      grip REAL,
      stance_note TEXT,
      affect_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_touchpoints_thread ON hippocampus_touchpoints (thread_id, created_at);

    CREATE TABLE IF NOT EXISTS hippocampus_constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      description TEXT NOT NULL,
      opt_out_proactive INTEGER NOT NULL DEFAULT 0,
      evidence_refs_json TEXT,
      evidence TEXT,
      segment_ref TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      recur TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      evidence TEXT,
      evidence_turn_id INTEGER,
      embedding TEXT,
      last_delivered_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_tick_log (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      tick_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      payload_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_hc_tick_log_scope ON hippocampus_tick_log (agent_id, user_id, triggered_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_self_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      trigger TEXT,
      turn_id INTEGER,
      closeness REAL NOT NULL DEFAULT 0,
      closeness_trend REAL NOT NULL DEFAULT 0,
      intimacy_tier TEXT NOT NULL DEFAULT 'surface',
      template_risk REAL NOT NULL DEFAULT 0,
      granularity TEXT,
      sample_count INTEGER,
      period TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_self_state_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      closeness REAL NOT NULL DEFAULT 0,
      closeness_trend REAL NOT NULL DEFAULT 0,
      template_risk REAL NOT NULL DEFAULT 0,
      intimacy_tier TEXT NOT NULL DEFAULT 'surface',
      sample_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, day)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_self_state_daily_scope
      ON hippocampus_self_state_daily (agent_id, user_id, day DESC);
    CREATE TABLE IF NOT EXISTS hippocampus_baselines (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      baseline_status TEXT NOT NULL DEFAULT 'cold',
      text_valence REAL,
      text_arousal REAL,
      text_dominance REAL,
      voice_affect_json TEXT,
      text_iqr_json TEXT,
      voice_iqr_json TEXT,
      text_samples_json TEXT,
      voice_samples_json TEXT,
      evidence_refs_json TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      text_sample_count INTEGER NOT NULL DEFAULT 0,
      voice_sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (agent_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS hippocampus_affect_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      thread_id INTEGER,
      turn_id INTEGER,
      channel TEXT NOT NULL DEFAULT 'text',
      source TEXT NOT NULL DEFAULT 'runtime',
      valence REAL,
      arousal REAL,
      dominance REAL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_affect_scope ON hippocampus_affect_points (agent_id, user_id, created_at);
    CREATE TABLE IF NOT EXISTS hippocampus_affect_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      day TEXT NOT NULL,
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      dominance REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, channel, day)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_affect_daily_scope
      ON hippocampus_affect_daily (agent_id, user_id, channel, day DESC);
    CREATE TABLE IF NOT EXISTS hippocampus_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_recall_traces (
      turn_id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_retrospect_buckets (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      granularity TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      is_frozen INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      narrative TEXT,
      dimensions_json TEXT,
      evidence_ids_json TEXT,
      themes_json TEXT,
      mood_trajectory_json TEXT,
      changes_json TEXT,
      portrait_source_marker TEXT,
      arc_source_marker TEXT,
      portrait_evidence_ids_json TEXT,
      arc_evidence_ids_json TEXT,
      portrait_frozen INTEGER DEFAULT 0,
      arc_frozen INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id, granularity, bucket_key)
    );
    CREATE TABLE IF NOT EXISTS hippocampus_portraits (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      narrative TEXT,
      dimensions_json TEXT,
      evidence_ids_json TEXT,
      last_stream_marker TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );

    -- v19: private digest high-water mark. 'last_message_id' is a desktop-only
    -- tie-breaker for messages sharing the same created_at (APP has no id here).
    CREATE TABLE IF NOT EXISTS digest_state (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      last_message_created_at TEXT,
      last_message_id INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS ix_digest_state_updated
      ON digest_state (updated_at);

    -- v19: cross-object background task event log. This is deliberately not
    -- 'task_events' (agent task runtime) and not 'hippocampus_tick_log'
    -- (per agent+user memory audit).
    CREATE TABLE IF NOT EXISTS background_task_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_background_task_events_created_at
      ON background_task_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_background_task_events_subject
      ON background_task_events (event_type, subject_type, subject_id, created_at DESC);

    -- v19: generic state-change ledger. M1 only backfills provable seed history;
    -- portrait entries start from the first real change after migration.
    CREATE TABLE IF NOT EXISTS agent_state_changes (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      base_revision INTEGER NOT NULL DEFAULT 0,
      new_revision INTEGER NOT NULL DEFAULT 0,
      before_json TEXT,
      after_json TEXT,
      reason TEXT NOT NULL DEFAULT '',
      evidence_json TEXT,
      batch_key TEXT,
      source TEXT NOT NULL DEFAULT 'model',
      created_at TEXT NOT NULL,
      UNIQUE (batch_key, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS ix_agent_state_changes_target
      ON agent_state_changes (agent_id, target_kind, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_agent_state_changes_scope_created
      ON agent_state_changes (agent_id, user_id, created_at DESC);

    -- v19: private conversation anchor (summary). Empty at migration time: no
    -- trustworthy historical summary exists, so none is invented.
    CREATE TABLE IF NOT EXISTS conversation_anchors (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      covered_at TEXT NOT NULL,
      covered_message_id INTEGER,
      updated_at TEXT NOT NULL,
      self_narrative TEXT NOT NULL DEFAULT '',
      self_dimensions_json TEXT NOT NULL DEFAULT '{}',
      self_retired_json TEXT NOT NULL DEFAULT '[]',
      self_updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (agent_id, user_id)
    );

    -- v21: the last real usage the most recent private chat request reported.
    -- It is the conversation anchor's primary trigger signal (APP
    -- NativeCoreMessages.lastChatUsage); the character estimate is only the
    -- fallback when no provider usage has been recorded yet.
    CREATE TABLE IF NOT EXISTS chat_usage_state (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      base_url_hash TEXT NOT NULL DEFAULT '',
      measured_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );

    -- v20: APP relationship continuity (shared context). This is deliberately
    -- separate from the retired desktop "心事线" tables and is not injected
    -- into chat prompts.
    CREATE TABLE IF NOT EXISTS relationship_threads (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      -- Incremental summary watermarks: the summary covers thread nodes up to
      -- summary_covered_message_id (occurred_at in summary_covered_at). They
      -- advance only when a digest actually adds later evidence.
      summary_covered_message_id TEXT,
      summary_covered_at TEXT,
      summary_updated_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      first_message_id TEXT NOT NULL,
      first_at TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      last_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_relationship_threads_agent_last
      ON relationship_threads (agent_id, user_id, last_at DESC);
    CREATE TABLE IF NOT EXISTS relationship_thread_nodes (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      carry_note TEXT NOT NULL DEFAULT '',
      batch_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS ix_relationship_thread_nodes_thread
      ON relationship_thread_nodes (thread_id, occurred_at);

    CREATE TABLE IF NOT EXISTS obs_snapshot_merge_log (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      merged_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, year, month)
    );
    CREATE INDEX IF NOT EXISTS ix_obs_snapshot_merge_scope
      ON obs_snapshot_merge_log (agent_id, user_id);

    CREATE TABLE IF NOT EXISTS wechat_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ilink_bot_id TEXT,
      bot_token TEXT,
      bot_user_id TEXT,
      base_url TEXT,
      agent_id INTEGER,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qqbot_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL UNIQUE,
      agent_id INTEGER NOT NULL UNIQUE,
      client_secret_enc TEXT NOT NULL,
      reply_with_voice INTEGER NOT NULL DEFAULT 0,
      enabled_private INTEGER NOT NULL DEFAULT 1,
      enabled_group INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_routes (
      agent_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      context_token TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, channel)
    );

    -- Desktop multi-agent group chat. Public events live in their own table so
    -- they can never leak into private chat threads or their prompt history.
    CREATE TABLE IF NOT EXISTS group_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_text TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_group_sessions_user_updated
      ON group_sessions (user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS group_members (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS ix_group_members_agent
      ON group_members (agent_id, status);

    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      speaker_type TEXT NOT NULL,
      speaker_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_group_messages_session_created
      ON group_messages (group_session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS ix_group_messages_turn
      ON group_messages (turn_id);

    CREATE TABLE IF NOT EXISTS group_read_state (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_conversation_anchors (
      group_session_id TEXT PRIMARY KEY REFERENCES group_sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL DEFAULT '',
      covered_message_id TEXT NOT NULL,
      covered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_digest_state (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL,
      last_message_created_at TEXT,
      last_message_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS group_director_turns (
      id TEXT PRIMARY KEY,
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_group_director_turns_session
      ON group_director_turns (group_session_id, created_at DESC);
  `);

  const current = database.pragma("user_version", { simple: true }) as number;
  if (current < 5) {
    addColumnIfMissing(database, "chat_threads", "pending_task_context", "TEXT");
  }
  if (current < 11) {
    addColumnIfMissing(database, "chat_threads", "active_skills", "TEXT");
    addColumnIfMissing(database, "chat_threads", "thread_skills", "TEXT");
  }
  if (current < 7) {
    addColumnIfMissing(database, "hippocampus_threads", "origin_note", "TEXT");
    addColumnIfMissing(database, "hippocampus_threads", "embedding", "BLOB");
    addColumnIfMissing(database, "hippocampus_threads", "embedding_dim", "INTEGER");
    addColumnIfMissing(database, "hippocampus_portraits", "last_stream_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_portraits", "created_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_source_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_source_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "baseline_status", "TEXT NOT NULL DEFAULT 'cold'");
    addColumnIfMissing(database, "hippocampus_baselines", "text_samples_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "voice_samples_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "evidence_refs_json", "TEXT");
  }
  if (current < 14) {
    // Additive migration: new columns/indexes/tables only. Safe to re-run.
    // v13 shipped the version bump before these columns in a hot-reload race,
    // so v14 re-runs the same idempotent statements for existing databases.
    addColumnIfMissing(database, "hippocampus_facts", "updated_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_entities", "narrative", "TEXT");
    addColumnIfMissing(database, "hippocampus_entities", "embedding", "BLOB");
    addColumnIfMissing(database, "hippocampus_entities", "embedding_dim", "INTEGER");
    addColumnIfMissing(database, "hippocampus_appointments", "embedding", "TEXT");
    addColumnIfMissing(
      database,
      "hippocampus_affect_points",
      "source",
      "TEXT NOT NULL DEFAULT 'runtime'",
    );
    addColumnIfMissing(database, "hippocampus_baselines", "created_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_evidence_ids_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_evidence_ids_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_frozen", "INTEGER DEFAULT 0");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_frozen", "INTEGER DEFAULT 0");

    // Unique indexes require existing duplicates to be removed first. Rows with
    // a NULL key are exempt because SQLite treats NULLs as distinct in unique
    // indexes, so they can never conflict.
    database.transaction(() => {
      database.exec(`
        DELETE FROM hippocampus_affect_points
        WHERE turn_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM hippocampus_affect_points
            WHERE turn_id IS NOT NULL
            GROUP BY turn_id, channel
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_affect_turn_channel
          ON hippocampus_affect_points (turn_id, channel);

        DELETE FROM hippocampus_constraints
        WHERE segment_ref IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM hippocampus_constraints
            WHERE segment_ref IS NOT NULL
            GROUP BY agent_id, user_id, segment_ref, description
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_constraints_scope_segment_desc
          ON hippocampus_constraints (agent_id, user_id, segment_ref, description);

        CREATE INDEX IF NOT EXISTS ix_hc_facts_from_status
          ON hippocampus_facts (from_entity_id, status);
        CREATE INDEX IF NOT EXISTS ix_hc_threads_scope_updated
          ON hippocampus_threads (agent_id, user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_scope_seed_created
          ON hippocampus_seed_versions (agent_id, user_id, seed_id, created_at);
        CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_scope_created
          ON hippocampus_seed_versions (agent_id, user_id, created_at);
      `);
    })();
  }
  if (current < 15) {
    // Additive seed metrics: count/last_seen power real salience instead of a
    // version-table proxy. Idempotent: only rows never backfilled (last_seen
    // IS NULL) are touched, so re-running the migration cannot reset counts.
    addColumnIfMissing(database, "hippocampus_seeds", "count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "hippocampus_seeds", "last_seen", "TEXT");
    database.transaction(() => {
      database.exec(`
        UPDATE hippocampus_seeds
        SET count = MAX(1, COALESCE((
              SELECT COUNT(*) FROM hippocampus_seed_versions v
              WHERE v.seed_id = hippocampus_seeds.id
                AND v.event_type IN ('new', 'reinforce', 'merge', 'revise')
            ), 0)),
            last_seen = COALESCE((
              SELECT MAX(v.created_at) FROM hippocampus_seed_versions v
              WHERE v.seed_id = hippocampus_seeds.id
                AND v.event_type IN ('new', 'reinforce', 'merge', 'revise')
            ), updated_at)
        WHERE last_seen IS NULL;
        CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_last_seen
          ON hippocampus_seeds (agent_id, user_id, last_seen DESC);
      `);
    })();
  }
  if (current < 16) {
    // Per-call request / response log (the GUI drawer's "调用记录" panel) plus
    // the cache counters the daily usage table needs. Additive and idempotent.
    addColumnIfMissing(database, "llm_token_usage_daily", "cache_creation", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "llm_token_usage_daily", "output_cached", "INTEGER NOT NULL DEFAULT 0");
    database.exec(`
      CREATE TABLE IF NOT EXISTS llm_call_traces (
        id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        tool_name TEXT,
        request_json TEXT,
        response_json TEXT,
        usage_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
        ON llm_call_traces (thread_id, created_at DESC);
    `);
  }
  if (current < 17) {
    // Per-call request / response log (the GUI drawer's "调用记录" panel) plus
    // the cache counters the daily usage table needs. Additive and idempotent.
    addColumnIfMissing(database, "llm_token_usage_daily", "cache_creation", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "llm_token_usage_daily", "output_cached", "INTEGER NOT NULL DEFAULT 0");
    database.exec(`
      CREATE TABLE IF NOT EXISTS llm_call_traces (
        id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        tool_name TEXT,
        request_json TEXT,
        response_json TEXT,
        usage_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
        ON llm_call_traces (thread_id, created_at DESC);
    `);
  }
  if (current < 19) {
    // v19: memory-alignment schema. One additive migration for the whole M1
    // write path (digest high-water mark, task events, seed lifecycle columns,
    // generic change ledger, private conversation anchors, theater provenance).
    // Nothing is dropped or retyped; every backfill is re-runnable.
    database.transaction(() => {
      // Ensure the v18 provenance columns exist before the normalization below
      // touches them. On a current v18 database these are no-ops.
      addColumnIfMissing(database, "hippocampus_streams", "origin_scope", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "perspective", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "origin_group_session_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "participants_json", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "origin_theater_id", "TEXT");
      database.exec(`
        CREATE INDEX IF NOT EXISTS ix_hc_streams_origin_scope
          ON hippocampus_streams (agent_id, user_id, archived, origin_scope, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_hc_streams_theater_origin
          ON hippocampus_streams (origin_theater_id, agent_id);
      `);

      addColumnIfMissing(database, "hippocampus_seeds", "revision", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(database, "hippocampus_seeds", "status", "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(database, "hippocampus_seeds", "applicability_json", "TEXT");
      database.exec(`
        CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_status
          ON hippocampus_seeds (agent_id, user_id, status, updated_at DESC);
      `);
      // revision: seed_versions starts at 1 = creation; APP revision starts at 0.
      database.exec(`
        UPDATE hippocampus_seeds
        SET revision = COALESCE((
          SELECT MAX(v.version_no) - 1
          FROM hippocampus_seed_versions v
          WHERE v.seed_id = hippocampus_seeds.id
            AND v.event_type <> 'delete'
        ), 0)
        WHERE revision = 0
          AND EXISTS (
            SELECT 1 FROM hippocampus_seed_versions v
            WHERE v.seed_id = hippocampus_seeds.id
              AND v.event_type <> 'delete'
              AND v.version_no > 1
          );
      `);

      database.exec(`
        CREATE TABLE IF NOT EXISTS digest_state (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          last_message_created_at TEXT,
          last_message_id INTEGER,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS ix_digest_state_updated
          ON digest_state (updated_at);

        CREATE TABLE IF NOT EXISTS background_task_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          subject_type TEXT NOT NULL DEFAULT '',
          subject_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_background_task_events_created_at
          ON background_task_events (created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_background_task_events_subject
          ON background_task_events (event_type, subject_type, subject_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_state_changes (
          id TEXT PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          action TEXT NOT NULL,
          base_revision INTEGER NOT NULL DEFAULT 0,
          new_revision INTEGER NOT NULL DEFAULT 0,
          before_json TEXT,
          after_json TEXT,
          reason TEXT NOT NULL DEFAULT '',
          evidence_json TEXT,
          batch_key TEXT,
          source TEXT NOT NULL DEFAULT 'model',
          created_at TEXT NOT NULL,
          UNIQUE (batch_key, target_kind, target_id)
        );
        CREATE INDEX IF NOT EXISTS ix_agent_state_changes_target
          ON agent_state_changes (agent_id, target_kind, target_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_agent_state_changes_scope_created
          ON agent_state_changes (agent_id, user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_anchors (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          covered_at TEXT NOT NULL,
          covered_message_id INTEGER,
          updated_at TEXT NOT NULL,
          self_narrative TEXT NOT NULL DEFAULT '',
          self_dimensions_json TEXT NOT NULL DEFAULT '{}',
          self_retired_json TEXT NOT NULL DEFAULT '[]',
          self_updated_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (agent_id, user_id)
        );
      `);

      // digest_state backfill from digested_at. A scope with an older
      // undigested assistant row has a hole in the old row-level marker; do not
      // fabricate a high-water mark that would skip that row.
      const digestScopes = database
        .prepare(
          `SELECT agent_id, user_id, MAX(id) AS max_id
           FROM chat_messages
           WHERE digested_at IS NOT NULL
           GROUP BY agent_id, user_id`,
        )
        .all() as { agent_id: number; user_id: string; max_id: number }[];
      const insertDigestState = database.prepare(
        `INSERT OR IGNORE INTO digest_state
          (agent_id, user_id, last_message_created_at, last_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertTaskEvent = database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const migrationEventId = `migration-v19-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      for (const scope of digestScopes) {
        const last = database
          .prepare("SELECT id, created_at FROM chat_messages WHERE id = ?")
          .get(scope.max_id) as { id: number; created_at: string } | undefined;
        if (!last?.created_at) continue;
        const hole = database
          .prepare(
            `SELECT 1 FROM chat_messages
             WHERE agent_id = ? AND user_id = ? AND role = 'assistant' AND status = 'completed'
               AND digested_at IS NULL
               AND (created_at < ? OR (created_at = ? AND id < ?))
             LIMIT 1`,
          )
          .get(scope.agent_id, scope.user_id, last.created_at, last.created_at, last.id);
        if (hole) {
          insertTaskEvent.run(
            `migration-v19-hole-${scope.agent_id}-${scope.user_id}-${Math.random().toString(36).slice(2, 8)}`,
            "schema_migration",
            "agent",
            String(scope.agent_id),
            "skipped",
            `digest_state_backfill_hole:${scope.user_id}`,
            new Date().toISOString(),
          );
          continue;
        }
        insertDigestState.run(
          scope.agent_id,
          scope.user_id,
          last.created_at,
          last.id,
          new Date().toISOString(),
        );
      }

      // streams scope/perspective/participants normalization (deterministic and
      // only for rows whose column is still empty; later writes are untouched).
      database.exec(`
        UPDATE hippocampus_streams
        SET origin_scope = CASE
          WHEN (origin_group_session_id IS NOT NULL AND TRIM(origin_group_session_id) <> '')
            OR type = 'group_presence'
            THEN 'group_public'
          ELSE 'private_dyadic'
        END
        WHERE origin_scope IS NULL OR TRIM(origin_scope) = '';

        UPDATE hippocampus_streams
        SET perspective = CASE
          WHEN origin_scope = 'group_public' THEN 'everyone'
          WHEN about IN ('她·感受', '她·在乎', '她·反应', '她·边界') THEN 'self'
          ELSE 'ta'
        END
        WHERE perspective IS NULL OR TRIM(perspective) = '';

        UPDATE hippocampus_streams
        SET participants_json = '[]'
        WHERE participants_json IS NULL OR TRIM(participants_json) = '';
      `);

      // Only provable seed history is backfilled. Portrait history is not
      // recoverable from a single current row and is deliberately left empty.
      database.exec(`
        INSERT OR IGNORE INTO agent_state_changes (
          id, agent_id, user_id, target_kind, target_id, action,
          base_revision, new_revision, before_json, after_json,
          reason, evidence_json, batch_key, source, created_at
        )
        SELECT
          'legacy-seedver-' || v.id,
          v.agent_id,
          v.user_id,
          'seed',
          v.seed_id,
          CASE v.event_type
            WHEN 'manual_create' THEN 'new'
            WHEN 'manual_update' THEN 'manual_edit'
            WHEN 'delete' THEN 'manual_delete'
            ELSE v.event_type
          END,
          MAX(v.version_no - 1, 0),
          v.version_no,
          v.before_json,
          v.after_json,
          COALESCE(v.reason, ''),
          NULL,
          'legacy-seedver:' || v.id,
          CASE
            WHEN v.trigger_source IN ('manual', 'system', 'model') THEN v.trigger_source
            ELSE 'legacy_backfill'
          END,
          v.created_at
        FROM hippocampus_seed_versions v
        WHERE v.seed_id IN (SELECT id FROM hippocampus_seeds);
      `);

      const badSeeds = database
        .prepare("SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE status NOT IN ('active','retired')")
        .get() as { c: number };
      const badStreams = database
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_streams
           WHERE origin_scope IS NULL OR TRIM(origin_scope) = ''
              OR perspective IS NULL OR TRIM(perspective) = ''`,
        )
        .get() as { c: number };
      if (Number(badSeeds.c) > 0) throw new Error("schema_v19_invalid_seed_status");
      if (Number(badStreams.c) > 0) throw new Error("schema_v19_invalid_stream_scope");

      insertTaskEvent.run(
        migrationEventId,
        "schema_migration",
        "global",
        "",
        "succeeded",
        "v19",
        new Date().toISOString(),
      );
    })();
  }
  if (current < 20) {
    // v20: APP relationship continuity tables. Empty at migration time: old
    // desktop "心事线" rows are not copied (that model is retired). Continuity
    // now writes only these tables and is never injected into chat prompts.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS relationship_threads (
          id TEXT PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          summary_covered_message_id TEXT,
          summary_covered_at TEXT,
          summary_updated_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          first_message_id TEXT NOT NULL,
          first_at TEXT NOT NULL,
          last_message_id TEXT NOT NULL,
          last_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_relationship_threads_agent_last
          ON relationship_threads (agent_id, user_id, last_at DESC);
        CREATE TABLE IF NOT EXISTS relationship_thread_nodes (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          carry_note TEXT NOT NULL DEFAULT '',
          batch_key TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS ix_relationship_thread_nodes_thread
          ON relationship_thread_nodes (thread_id, occurred_at);
      `);
      database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v20', ?)`,
      ).run(`migration-v20-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
    })();
  }
  if (current < 21) {
    // v21: chat_usage_state — the anchor's real-usage trigger signal. Empty at
    // migration time: without a recorded row the estimate fallback stays in
    // charge until the next private chat request reports usage.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_usage_state (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL DEFAULT '',
          base_url_hash TEXT NOT NULL DEFAULT '',
          measured_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, user_id)
        );
      `);
      database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v21', ?)`,
      ).run(`migration-v21-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
    })();
  }
  if (current < 22) {
    // v22: the APP's formal package no longer exposes or honors a "deep memory"
    // toggle. Drop the retired column; legacy booleans must not survive as a
    // hidden behavior switch.
    dropColumnIfPresent(database, "agent_configs", "deep_memory_enabled");
    database.prepare(
      `INSERT INTO background_task_events
        (id, event_type, subject_type, subject_id, status, detail, created_at)
       VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v22', ?)`,
    ).run(`migration-v22-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
  }
  if (current < 23) {
    // v23: graphiti-inspired long-term memory Phase 0–1. Additive only:
    // episodes / sources / digest jobs / predicate registry / aliases / merges,
    // plus the double-time columns on facts and provenance columns on the
    // existing memory tables. Nothing is dropped or retyped.
    database.transaction(() => {
      ensureV23Tables(database);

      addColumnIfMissing(database, "hippocampus_entities", "kind", "TEXT NOT NULL DEFAULT 'other'");
      addColumnIfMissing(database, "hippocampus_entities", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(database, "hippocampus_entities", "summary", "TEXT");
      addColumnIfMissing(database, "hippocampus_entities", "summary_updated_at", "TEXT");
      addColumnIfMissing(database, "hippocampus_entities", "merged_into_id", "TEXT");

      addColumnIfMissing(database, "hippocampus_facts", "valid_at", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "invalid_at", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "superseded_by_fact_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "invalidation_reason", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "source_episode_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "cardinality", "TEXT NOT NULL DEFAULT 'many'");
      addColumnIfMissing(database, "hippocampus_facts", "extractor_version", "TEXT");
      addColumnIfMissing(database, "hippocampus_facts", "prompt_version", "TEXT");
      // Pre-tokenized description for the external-content FTS index. NULL is
      // the "not backfilled yet" sentinel, so it is added without a default.
      addColumnIfMissing(database, "hippocampus_facts", "description_tokens", "TEXT");

      // v23 backfill: pre-v23 facts only had created_at, so `valid_at` would
      // stay NULL forever. The double-time predicate treats a missing
      // valid_at as created_at; write that equivalence down once so later
      // queries, indexes and exports all see the same value.
      database.exec(`
        UPDATE hippocampus_facts
        SET valid_at = COALESCE(valid_at, created_at)
        WHERE valid_at IS NULL;
      `);

      addColumnIfMissing(database, "hippocampus_streams", "episode_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "source_message_ids_json", "TEXT");
      addColumnIfMissing(
        database,
        "hippocampus_edges",
        "edge_class",
        "TEXT NOT NULL DEFAULT 'associative'",
      );
      addColumnIfMissing(database, "hippocampus_edges", "source_episode_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_threads", "summary", "TEXT");
      addColumnIfMissing(database, "hippocampus_threads", "summary_covered_stream_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_threads", "summary_covered_valid_at", "TEXT");
      addColumnIfMissing(database, "hippocampus_threads", "summary_updated_at", "TEXT");
      addColumnIfMissing(database, "hippocampus_touchpoints", "episode_id", "TEXT");

      // Seed the 15 existing relations once. INSERT OR IGNORE keeps later
      // manual cardinality changes intact on every re-run.
      database.exec(`
        INSERT OR IGNORE INTO hippocampus_predicates
          (name, subject_kind, object_kind, cardinality, symmetric, invalidation_policy, description)
        VALUES
          ('HAS_NAME', NULL, NULL, 'one', 0, 'supersede', '名字'),
          ('AGE', NULL, NULL, 'one', 0, 'supersede', '年龄'),
          ('GENDER', NULL, NULL, 'one', 0, 'supersede', '性别'),
          ('LIVES_IN', NULL, 'location', 'one', 0, 'supersede', '现居地'),
          ('OCCUPATION', NULL, NULL, 'one', 0, 'supersede', '职业'),
          ('SLEEP_PATTERN', NULL, NULL, 'one', 0, 'supersede', '作息'),
          ('HAS_WORK_PATTERN', NULL, NULL, 'one', 0, 'supersede', '工作模式'),
          ('LIKES', NULL, NULL, 'many', 0, 'additive', '喜欢的事物'),
          ('DISLIKES', NULL, NULL, 'many', 0, 'additive', '不喜欢的事物'),
          ('HAS_PET', NULL, 'pet', 'many', 0, 'additive', '宠物'),
          ('HAS_FRIEND', NULL, 'person', 'many', 0, 'additive', '朋友'),
          ('HAS_FAMILY', NULL, 'person', 'many', 0, 'additive', '家人'),
          ('INTERESTED_IN', NULL, NULL, 'many', 0, 'additive', '兴趣'),
          ('HAS_HEALTH_CONDITION', NULL, NULL, 'many', 0, 'additive', '健康状况'),
          ('HAS_ROUTINE', NULL, NULL, 'many', 0, 'additive', '习惯');
      `);

      // Legacy entities carried their old category in `type` (which now means
      // role). Keep user/self anchors as people; copy the real kind over.
      database.exec(`
        UPDATE hippocampus_entities
        SET kind = CASE
          WHEN type IN ('person', 'location', 'organization', 'pet', 'object',
                        'concept', 'activity', 'event', 'theme', 'emotion')
            THEN type
          WHEN type IN ('user', 'self') THEN 'person'
          ELSE 'other'
        END
        WHERE kind IS NULL OR kind = 'other';
      `);

      // Backfill fact cardinality from the registry before the partial unique
      // index is created. Existing rows never had a cardinality column.
      database.exec(`
        UPDATE hippocampus_facts
        SET cardinality = 'one'
        WHERE UPPER(relation) IN (
          'HAS_NAME', 'AGE', 'GENDER', 'LIVES_IN', 'OCCUPATION',
          'SLEEP_PATTERN', 'HAS_WORK_PATTERN'
        );
        UPDATE hippocampus_facts
        SET cardinality = 'many'
        WHERE cardinality IS NULL OR cardinality NOT IN ('one', 'many');
      `);

      // A pre-v23 database may already hold several "current" single-value
      // rows from repeated updates. Keep the newest, soft-expire the surplus so
      // the partial unique index can be created without deleting anything.
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE hippocampus_facts
           SET status = 'expired', expired_at = COALESCE(expired_at, ?),
               invalid_at = COALESCE(invalid_at, ?),
               invalidation_reason = COALESCE(invalidation_reason, 'migration_dedupe'),
               updated_at = ?
           WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY agent_id, user_id, from_entity_id, relation
                 ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC
               ) AS rn
               FROM hippocampus_facts
               WHERE cardinality = 'one' AND expired_at IS NULL
             ) WHERE rn > 1
           )`,
        )
        .run(now, now, now);

      database.exec(`
        CREATE INDEX IF NOT EXISTS ix_hc_facts_scope_subject
          ON hippocampus_facts (agent_id, user_id, from_entity_id, relation, expired_at);
        CREATE INDEX IF NOT EXISTS ix_hc_facts_scope_object
          ON hippocampus_facts (agent_id, user_id, to_entity_id, relation, expired_at);
        CREATE INDEX IF NOT EXISTS ix_hc_facts_scope_valid
          ON hippocampus_facts (agent_id, user_id, valid_at, invalid_at);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_facts_current_single
          ON hippocampus_facts (agent_id, user_id, from_entity_id, relation)
          WHERE cardinality = 'one' AND expired_at IS NULL;
        CREATE INDEX IF NOT EXISTS ix_hc_entities_scope_name
          ON hippocampus_entities (agent_id, user_id, name);
        CREATE INDEX IF NOT EXISTS ix_hc_entities_scope_kind
          ON hippocampus_entities (agent_id, user_id, kind);
        CREATE INDEX IF NOT EXISTS ix_hc_edges_class
          ON hippocampus_edges (agent_id, user_id, edge_class);

        CREATE VIEW IF NOT EXISTS v_hc_facts_current AS
        SELECT *
        FROM hippocampus_facts
        WHERE expired_at IS NULL
          AND COALESCE(valid_at, created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND (invalid_at IS NULL OR invalid_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);

      database
        .prepare(
          `INSERT INTO background_task_events
            (id, event_type, subject_type, subject_id, status, detail, created_at)
           VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v23', ?)`,
        )
        .run(
          `migration-v23-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          new Date().toISOString(),
        );
    })();
  }
  // The v22 drop is unconditional too. A hot reload can set user_version=22
  // before this migration block is loaded, exactly like the seed-column race.
  dropColumnIfPresent(database, "agent_configs", "deep_memory_enabled");
  // Unconditional and idempotent: these columns are what lets the next request
  // replay the previous one byte for byte, which is what the provider's prompt
  // cache keys on. They must exist even on a database that already reached the
  // current schema version before they were introduced.
  addColumnIfMissing(database, "chat_messages", "tool_messages_json", "TEXT");
  addColumnIfMissing(database, "chat_messages", "llm_content", "TEXT");
  addColumnIfMissing(database, "chat_threads", "llm_anchor_message_id", "INTEGER");
  // v20 relationship summary watermarks are unconditional too. A database that
  // reached v20 before these columns were introduced still has the table, and
  // the digest writer assumes the columns exist.
  addColumnIfMissing(database, "relationship_threads", "summary_covered_message_id", "TEXT");
  addColumnIfMissing(database, "relationship_threads", "summary_covered_at", "TEXT");
  addColumnIfMissing(database, "relationship_threads", "summary_updated_at", "TEXT");
  // v18: group-public stream provenance. Additive only; existing streams keep
  // NULL and are therefore still treated as private memory.
  addColumnIfMissing(database, "hippocampus_streams", "origin_group_session_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "participants_json", "TEXT");
  // v19 seed lifecycle columns are unconditional too: a hot reload can move
  // `user_version` forward before the version-guarded block commits, leaving a
  // v19+ database without the columns the new code assumes.
  addColumnIfMissing(database, "hippocampus_seeds", "revision", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "hippocampus_seeds", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(database, "hippocampus_seeds", "applicability_json", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "origin_theater_id", "TEXT");
  // M3 manage_alarm: APP-compatible appointment time modes. Legacy rows keep
  // NULL and read as the historical exact-time appointments.
  addColumnIfMissing(database, "hippocampus_appointments", "time_mode", "TEXT");
  addColumnIfMissing(database, "hippocampus_appointments", "event_date", "TEXT");
  // v23 columns are unconditional too: a hot reload can advance user_version
  // before the version-guarded migration block commits.
  addColumnIfMissing(database, "hippocampus_entities", "kind", "TEXT NOT NULL DEFAULT 'other'");
  addColumnIfMissing(database, "hippocampus_entities", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(database, "hippocampus_entities", "summary", "TEXT");
  addColumnIfMissing(database, "hippocampus_entities", "summary_updated_at", "TEXT");
  addColumnIfMissing(database, "hippocampus_entities", "merged_into_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "valid_at", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "invalid_at", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "superseded_by_fact_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "invalidation_reason", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "source_episode_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "cardinality", "TEXT NOT NULL DEFAULT 'many'");
  addColumnIfMissing(database, "hippocampus_facts", "extractor_version", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "prompt_version", "TEXT");
  addColumnIfMissing(database, "hippocampus_facts", "description_tokens", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "episode_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "source_message_ids_json", "TEXT");
  addColumnIfMissing(database, "hippocampus_edges", "edge_class", "TEXT NOT NULL DEFAULT 'associative'");
  addColumnIfMissing(database, "hippocampus_edges", "source_episode_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_threads", "summary", "TEXT");
  addColumnIfMissing(database, "hippocampus_threads", "summary_covered_stream_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_threads", "summary_covered_valid_at", "TEXT");
  addColumnIfMissing(database, "hippocampus_threads", "summary_updated_at", "TEXT");
  addColumnIfMissing(database, "hippocampus_touchpoints", "episode_id", "TEXT");
  // v23 new tables live in an unconditional repair block too: a hot reload can
  // advance user_version past 23 before the version-guarded migration commits,
  // leaving the database without tables the new code assumes exist.
  ensureV23Tables(database);
  // FTS lives outside ensureV23Tables: it needs `description_tokens`, which is
  // added just above, and startup must run the bounded backfill exactly once.
  ensureFactFtsTable(database);
  // Backfill is idempotent; it also repairs a database that reached 23 without
  // the migration's backfill (partial migration / hot reload).
  database.exec(`
    UPDATE hippocampus_facts
    SET valid_at = COALESCE(valid_at, created_at)
    WHERE valid_at IS NULL;
  `);
  // CREATE VIEW IF NOT EXISTS would keep an older v23 definition forever.
  // Recreate it so every database gets the COALESCE(valid_at, created_at)
  // predicate (legacy facts legitimately have NULL valid_at).
  database.exec(`
    DROP VIEW IF EXISTS v_hc_facts_current;
    CREATE VIEW v_hc_facts_current AS
    SELECT *
    FROM hippocampus_facts
    WHERE expired_at IS NULL
      AND COALESCE(valid_at, created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (invalid_at IS NULL OR invalid_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS ix_hc_streams_group_origin
       ON hippocampus_streams (origin_group_session_id, agent_id);
    CREATE INDEX IF NOT EXISTS ix_hc_streams_origin_scope
      ON hippocampus_streams (agent_id, user_id, archived, origin_scope, created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_hc_streams_theater_origin
      ON hippocampus_streams (origin_theater_id, agent_id);
    CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_status
      ON hippocampus_seeds (agent_id, user_id, status, updated_at DESC);
  `);
  if (current < SCHEMA_VERSION) {
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * v23 long-term-memory tables. Kept in one idempotent function so both the
 * version-guarded migration and the unconditional startup repair create the
 * same schema (hot reload can advance user_version before the migration
 * transaction commits).
 */
function ensureV23Tables(database: Database.Database) {
  // The FTS token column is part of the v23 fact shape; add it here too so any
  // caller of this idempotent repair gets a complete facts table even before
  // the version-guarded addColumn list runs.
  addColumnIfMissing(database, "hippocampus_facts", "description_tokens", "TEXT");
  database.exec(`
    CREATE TABLE IF NOT EXISTS hippocampus_episodes (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      thread_id INTEGER,
      source TEXT NOT NULL DEFAULT 'chat',
      source_description TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      reference_time TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      message_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_episodes_scope_time
      ON hippocampus_episodes (agent_id, user_id, ended_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_fact_sources (
      fact_id TEXT NOT NULL REFERENCES hippocampus_facts(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES hippocampus_episodes(id) ON DELETE CASCADE,
      stream_id TEXT,
      evidence_quote TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (fact_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_fact_sources_episode
      ON hippocampus_fact_sources (episode_id);

    CREATE TABLE IF NOT EXISTS hippocampus_digest_jobs (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      from_message_id INTEGER NOT NULL,
      to_message_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'failed', 'stale')),
      attempts INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      last_error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_digest_jobs_range
      ON hippocampus_digest_jobs
         (agent_id, user_id, from_message_id, to_message_id, content_hash);
    CREATE INDEX IF NOT EXISTS ix_hc_digest_jobs_status
      ON hippocampus_digest_jobs (status, created_at);

    CREATE TABLE IF NOT EXISTS hippocampus_predicates (
      name TEXT PRIMARY KEY,
      subject_kind TEXT,
      object_kind TEXT,
      cardinality TEXT NOT NULL CHECK (cardinality IN ('one', 'many')),
      symmetric INTEGER NOT NULL DEFAULT 0,
      invalidation_policy TEXT NOT NULL DEFAULT 'supersede'
        CHECK (invalidation_policy IN ('supersede', 'additive', 'never')),
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS hippocampus_entity_aliases (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES hippocampus_entities(id),
      alias TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      alias_hash TEXT NOT NULL,
      source_episode_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, entity_id, alias_hash)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_alias_lookup
      ON hippocampus_entity_aliases (agent_id, user_id, alias_hash);

    CREATE TABLE IF NOT EXISTS hippocampus_entity_merges (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      into_entity_id TEXT NOT NULL,
      reason TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      unmerged_at TEXT,
      UNIQUE (agent_id, user_id, from_entity_id, into_entity_id)
    );
  `);
  // Seed the 15 existing relations here too: the unconditional repair path
  // can recreate an empty predicates table on a database whose user_version
  // already reached 23, and INSERT OR IGNORE keeps manual edits intact.
  database.exec(`
    INSERT OR IGNORE INTO hippocampus_predicates
      (name, subject_kind, object_kind, cardinality, symmetric, invalidation_policy, description)
    VALUES
      ('HAS_NAME', NULL, NULL, 'one', 0, 'supersede', '名字'),
      ('AGE', NULL, NULL, 'one', 0, 'supersede', '年龄'),
      ('GENDER', NULL, NULL, 'one', 0, 'supersede', '性别'),
      ('LIVES_IN', NULL, 'location', 'one', 0, 'supersede', '现居地'),
      ('OCCUPATION', NULL, NULL, 'one', 0, 'supersede', '职业'),
      ('SLEEP_PATTERN', NULL, NULL, 'one', 0, 'supersede', '作息'),
      ('HAS_WORK_PATTERN', NULL, NULL, 'one', 0, 'supersede', '工作模式'),
      ('LIKES', NULL, NULL, 'many', 0, 'additive', '喜欢的事物'),
      ('DISLIKES', NULL, NULL, 'many', 0, 'additive', '不喜欢的事物'),
      ('HAS_PET', NULL, 'pet', 'many', 0, 'additive', '宠物'),
      ('HAS_FRIEND', NULL, 'person', 'many', 0, 'additive', '朋友'),
      ('HAS_FAMILY', NULL, 'person', 'many', 0, 'additive', '家人'),
      ('INTERESTED_IN', NULL, NULL, 'many', 0, 'additive', '兴趣'),
      ('HAS_HEALTH_CONDITION', NULL, NULL, 'many', 0, 'additive', '健康状况'),
      ('HAS_ROUTINE', NULL, NULL, 'many', 0, 'additive', '习惯');
  `);
}

let factFtsWarningLogged = false;
let factFtsSchemaReady = false;

/**
 * External-content FTS5 table. `description_tokens` is the only indexed
 * column; the fact row is the content and its integer `rowid` is the join key
 * (facts keep a TEXT primary key, but every ordinary SQLite table has a
 * rowid). Application code computes tokens once and stores them on the fact;
 * triggers mirror that column into FTS.
 */
export const FACT_FTS_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS hippocampus_fact_fts USING fts5(
  description_tokens,
  content='hippocampus_facts',
  content_rowid='rowid',
  tokenize='unicode61'
);`;

/**
 * Trigger design note (learned the hard way on better-sqlite3/SQLite 3.53):
 * a literal external-content update trigger that always runs
 * `'delete'` + insert corrupts the index (`database disk image is malformed`)
 * when the old row was never indexed — exactly what happens while a legacy
 * database is being backfilled. The guards below keep one invariant:
 *
 *   description_tokens IS NULL  <=>  the fact has no FTS index entry.
 *
 * The insert trigger skips NULL tokens. The delete trigger skips NULL tokens.
 * The token-update trigger only fires for a real, non-NULL token change, so a
 * NULL->tokens backfill is an insert, never a delete of a missing row. A direct
 * `UPDATE description` (bypassing writeFact) deletes the old entry and clears
 * tokens; the repair batch later recomputes them. The description and token
 * triggers are mutually exclusive, so no trigger program deletes the same FTS
 * row twice (that is the corruption path).
 */
export const FACT_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS hippocampus_fact_fts_ai
  AFTER INSERT ON hippocampus_facts
  WHEN new.description_tokens IS NOT NULL
  BEGIN
    INSERT INTO hippocampus_fact_fts(rowid, description_tokens)
    VALUES (new.rowid, new.description_tokens);
  END;

  CREATE TRIGGER IF NOT EXISTS hippocampus_fact_fts_ad
  AFTER DELETE ON hippocampus_facts
  WHEN old.description_tokens IS NOT NULL
  BEGIN
    INSERT INTO hippocampus_fact_fts(hippocampus_fact_fts, rowid, description_tokens)
    VALUES ('delete', old.rowid, old.description_tokens);
  END;

  CREATE TRIGGER IF NOT EXISTS hippocampus_fact_fts_au
  AFTER UPDATE OF description_tokens ON hippocampus_facts
  WHEN new.description_tokens IS NOT NULL
   AND new.description_tokens IS NOT old.description_tokens
  BEGIN
    INSERT INTO hippocampus_fact_fts(hippocampus_fact_fts, rowid, description_tokens)
    SELECT 'delete', old.rowid, old.description_tokens
    WHERE old.description_tokens IS NOT NULL;
    INSERT INTO hippocampus_fact_fts(rowid, description_tokens)
    VALUES (new.rowid, new.description_tokens);
  END;

  CREATE TRIGGER IF NOT EXISTS hippocampus_fact_fts_desc
  AFTER UPDATE OF description ON hippocampus_facts
  WHEN new.description IS NOT old.description
   AND new.description_tokens IS old.description_tokens
  BEGIN
    INSERT INTO hippocampus_fact_fts(hippocampus_fact_fts, rowid, description_tokens)
    SELECT 'delete', old.rowid, old.description_tokens
    WHERE old.description_tokens IS NOT NULL;
    UPDATE hippocampus_facts SET description_tokens = NULL WHERE id = new.id;
  END;
`;

/**
 * Incrementally compute `description_tokens` for facts that do not have them.
 * Only missing rows are touched; existing tokens and existing FTS entries are
 * never deleted or rebuilt. Batched so a 100k-fact database does not block
 * startup or a search.
 */
export function repairFactFtsBatch(
  database: Database.Database,
  limit = 1000,
): number {
  if (process.env.LINGSHU_DISABLE_FACT_FTS === "1") return 0;
  const requested = Number(limit);
  const batchSize =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1000;
  const rows = database
    .prepare(
      `SELECT id, description FROM hippocampus_facts
       WHERE description_tokens IS NULL
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .all(batchSize) as { id: string; description: string | null }[];
  if (!rows.length) return 0;
  const update = database.prepare(
    `UPDATE hippocampus_facts
     SET description_tokens = ?
     WHERE id = ? AND description_tokens IS NULL`,
  );
  return database.transaction(() => {
    let changed = 0;
    for (const row of rows) {
      changed += update.run(
        tokenize(String(row.description ?? "")).join(" "),
        String(row.id),
      ).changes;
    }
    return changed;
  })();
}

/**
 * Ensure the FTS schema exists and advance the bounded backfill by one batch.
 * Best-effort: a SQLite build without FTS5 must never fail startup.
 *
 * Migration path for the old standalone table (`fact_id UNINDEXED`): detect
 * the definition in sqlite_master, drop only the index, recreate it as
 * external-content and let the incremental backfill repopulate it. Facts are
 * never rewritten during this schema upgrade.
 */
export function ensureFactFtsTable(database: Database.Database): boolean {
  if (process.env.LINGSHU_DISABLE_FACT_FTS === "1") return false;
  if (factFtsSchemaReady) return true;
  try {
    const existing = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hippocampus_fact_fts'",
      )
      .get() as { sql?: string } | undefined;
    const existingSql = String(existing?.sql || "");
    const isExternalContent =
      /content\s*=\s*['"]hippocampus_facts['"]/i.test(existingSql) &&
      /content_rowid\s*=\s*['"]rowid['"]/i.test(existingSql);

    // Always recreate the triggers: an old definition (or triggers left behind
    // after a manual table drop) must never survive a schema upgrade.
    database.exec(`
      DROP TRIGGER IF EXISTS hippocampus_fact_fts_ai;
      DROP TRIGGER IF EXISTS hippocampus_fact_fts_ad;
      DROP TRIGGER IF EXISTS hippocampus_fact_fts_au;
      DROP TRIGGER IF EXISTS hippocampus_fact_fts_desc;
    `);
    if (existing && !isExternalContent) {
      // Old standalone table: drop the index only. Facts stay untouched.
      database.exec("DROP TABLE hippocampus_fact_fts;");
    }
    database.exec(FACT_FTS_TABLE_SQL);
    database.exec(FACT_FTS_TRIGGERS_SQL);
    if (!existing || !isExternalContent) {
      // A newly-created external-content index is empty even when facts already
      // carry tokens (e.g. the table was lost and is being repaired). Seed it
      // from the persisted tokens in one set-based statement; no tokenization.
      database
        .prepare(
          `INSERT INTO hippocampus_fact_fts(rowid, description_tokens)
           SELECT rowid, description_tokens FROM hippocampus_facts
           WHERE description_tokens IS NOT NULL`,
        )
        .run();
    }
    // Keeps `WHERE description_tokens IS NULL ORDER BY rowid LIMIT n` cheap on
    // large fact tables (partial index: only pending rows are indexed).
    database.exec(`
      CREATE INDEX IF NOT EXISTS ix_hc_facts_fts_pending
        ON hippocampus_facts(description_tokens) WHERE description_tokens IS NULL;
    `);
    // Startup backfill is deliberately bounded. Remaining rows are picked up
    // by searchFactFts (max 500/search) or a later startup.
    repairFactFtsBatch(database, 1000);
    factFtsSchemaReady = true;
    return true;
  } catch (error) {
    if (!factFtsWarningLogged) {
      factFtsWarningLogged = true;
      console.warn("[MEMORY_FACT_FTS] FTS5 unavailable, fact search uses in-memory BM25", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

/** Test/ops hook: force the next ensure call to re-check the schema. */
export function resetFactFtsSchemaCacheForTests(): void {
  factFtsSchemaReady = false;
}

function addColumnIfMissing(database: Database.Database, table: string, column: string, ddl: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!rows.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function dropColumnIfPresent(database: Database.Database, table: string, column: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
  factFtsSchemaReady = false;
}