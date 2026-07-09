import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { ulid } from 'ulidx';
import * as schema from './schema.js';

const DB_PATH = process.env.DB_PATH || 'propanes.db';

const sqlite: DatabaseType = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };

export function runMigrations() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS feedback_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'new',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      data TEXT,
      context TEXT,
      source_url TEXT,
      user_agent TEXT,
      viewport TEXT,
      session_id TEXT,
      user_id TEXT,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
      dispatched_to TEXT,
      dispatched_at TEXT,
      dispatch_status TEXT,
      dispatch_response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback_screenshots (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback_tags (
      feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (feedback_id, tag)
    );

    CREATE TABLE IF NOT EXISTS agent_endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      auth_header TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_items(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback_items(type);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_items(created_at);
    CREATE INDEX IF NOT EXISTS idx_screenshots_feedback ON feedback_screenshots(feedback_id);

    CREATE TABLE IF NOT EXISTS feedback_audio (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audio_feedback ON feedback_audio(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_tags_feedback ON feedback_tags(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON feedback_tags(tag);

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      project_dir TEXT NOT NULL,
      server_url TEXT,
      hooks TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_applications_api_key ON applications(api_key);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      agent_endpoint_id TEXT NOT NULL REFERENCES agent_endpoints(id) ON DELETE CASCADE,
      permission_profile TEXT NOT NULL DEFAULT 'interactive-require',
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      exit_code INTEGER,
      output_log TEXT,
      output_bytes INTEGER NOT NULL DEFAULT 0,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_feedback ON agent_sessions(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      group_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      linked_feedback_ids TEXT NOT NULL DEFAULT '[]',
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_plans_group_key ON plans(group_key);
    CREATE INDEX IF NOT EXISTS idx_plans_app_id ON plans(app_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS flatter_monitors (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      baseline_ref TEXT,
      baseline_date TEXT,
      focus_json TEXT NOT NULL DEFAULT '{}',
      last_head_sha TEXT,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flatter_monitors_app ON flatter_monitors(app_id, updated_at);

    CREATE TABLE IF NOT EXISTS flatter_reports (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      monitor_id TEXT NOT NULL REFERENCES flatter_monitors(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      upstream_head_sha TEXT,
      baseline_summary TEXT,
      summary TEXT NOT NULL DEFAULT '',
      stats_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flatter_reports_monitor ON flatter_reports(monitor_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_flatter_reports_app ON flatter_reports(app_id, created_at);

    CREATE TABLE IF NOT EXISTS flatter_items (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES flatter_reports(id) ON DELETE CASCADE,
      monitor_id TEXT NOT NULL REFERENCES flatter_monitors(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'commit',
      upstream_ref TEXT,
      upstream_url TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'nice',
      relevance TEXT NOT NULL DEFAULT 'medium',
      risk TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'proposed',
      rationale TEXT NOT NULL DEFAULT '',
      scope_notes TEXT NOT NULL DEFAULT '',
      operator_notes TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flatter_items_report ON flatter_items(report_id, category, updated_at);
    CREATE INDEX IF NOT EXISTS idx_flatter_items_app ON flatter_items(app_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS flatter_plans (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      report_id TEXT REFERENCES flatter_reports(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready',
      items_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flatter_plans_app ON flatter_plans(app_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_flatter_plans_status ON flatter_plans(app_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS flatter_runs (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES flatter_items(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES flatter_plans(id) ON DELETE SET NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      columns_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_flatter_runs_item ON flatter_runs(item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_flatter_runs_app ON flatter_runs(app_id, updated_at);
  `);

  // Add new columns to existing tables (idempotent via try/catch)
  const alterStatements = [
    `ALTER TABLE feedback_items ADD COLUMN app_id TEXT REFERENCES applications(id) ON DELETE SET NULL`,
    `ALTER TABLE agent_endpoints ADD COLUMN app_id TEXT REFERENCES applications(id) ON DELETE SET NULL`,
    `ALTER TABLE agent_endpoints ADD COLUMN prompt_template TEXT`,
    `ALTER TABLE agent_endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'webhook'`,
    `ALTER TABLE agent_endpoints ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'`,
    `ALTER TABLE agent_endpoints ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'interactive-require'`,
    `ALTER TABLE agent_endpoints ADD COLUMN allowed_tools TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'`,
    `ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT`,
    `ALTER TABLE agent_endpoints ADD COLUMN auto_plan INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_sessions ADD COLUMN last_output_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_sessions ADD COLUMN last_input_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_sessions ADD COLUMN tmux_session_name TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN launcher_id TEXT`,
    `ALTER TABLE agent_endpoints ADD COLUMN preferred_launcher_id TEXT`,
    `ALTER TABLE applications ADD COLUMN tmux_config_id TEXT`,
    `ALTER TABLE applications ADD COLUMN default_permission_profile TEXT DEFAULT 'interactive-require'`,
    `ALTER TABLE applications ADD COLUMN default_allowed_tools TEXT`,
    `ALTER TABLE applications ADD COLUMN agent_path TEXT`,
    `ALTER TABLE applications ADD COLUMN screenshot_include_widget INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE applications ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_sessions ADD COLUMN claude_session_id TEXT`,
    `ALTER TABLE applications ADD COLUMN control_actions TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE agent_endpoints ADD COLUMN harness_config_id TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN machine_id TEXT`,
    `ALTER TABLE applications ADD COLUMN request_panel TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE agent_sessions ADD COLUMN companion_session_id TEXT`,
    `ALTER TABLE harness_configs ADD COLUMN compose_dir TEXT`,
    `ALTER TABLE machines ADD COLUMN default_cwd TEXT`,
    `ALTER TABLE harness_configs ADD COLUMN host_terminal_access INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE harness_configs ADD COLUMN claude_home_path TEXT`,
    `ALTER TABLE harness_configs ADD COLUMN anthropic_api_key TEXT`,
    `ALTER TABLE agent_endpoints ADD COLUMN sprite_config_id TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN sprite_config_id TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN sprite_exec_session_id TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN cwd TEXT`,
    `ALTER TABLE machines ADD COLUMN admin_url TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN prompt_file TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN log_file TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN agent_label TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN fitness_detail TEXT`,
    `ALTER TABLE feedback_items ADD COLUMN title_history TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE wiggum_swarms ADD COLUMN max_generations INTEGER`,
    `ALTER TABLE cos_threads ADD COLUMN claude_session_id TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN last_activity_at TEXT`,
    `ALTER TABLE cos_messages ADD COLUMN attachments_json TEXT`,
    `ALTER TABLE cos_learnings ADD COLUMN tags TEXT`,
    `ALTER TABLE agent_sessions ADD COLUMN cos_thread_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_thread_created ON agent_sessions(cos_thread_id, created_at)`,
    `ALTER TABLE agent_sessions ADD COLUMN title TEXT`,
    `ALTER TABLE cos_threads ADD COLUMN agent_session_id TEXT`,
    `ALTER TABLE cos_threads ADD COLUMN turn_started_at INTEGER`,
    `ALTER TABLE cos_threads ADD COLUMN turn_start_seq INTEGER`,
    `ALTER TABLE cos_threads ADD COLUMN turn_user_text TEXT`,
    `ALTER TABLE cos_threads ADD COLUMN turn_request_id TEXT`,
    // cos_drafts gained a thread_id column to support per-(agent, app, thread)
    // scopes (reply-in-thread vs. new-thread). Existing rows default to ''
    // (the new-thread scope) which preserves prior behavior.
    `ALTER TABLE cos_drafts ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''`,
    `DROP INDEX IF EXISTS idx_cos_drafts_agent_app`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_drafts_agent_app_thread ON cos_drafts(agent_id, app_id, thread_id)`,
    `ALTER TABLE cos_threads ADD COLUMN resolved_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_cos_threads_resolved ON cos_threads(resolved_at)`,
    `ALTER TABLE cos_threads ADD COLUMN archived_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_cos_threads_archived ON cos_threads(archived_at)`,
    // Slack-style channels: per-app buckets of threads with a policyJson blob
    // gating dispatch (allowed profiles, agent allowlist, approval gate). See
    // cosChannels in schema.ts and the channel routes for shape.
    `ALTER TABLE cos_threads ADD COLUMN channel_id TEXT REFERENCES cos_channels(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_cos_threads_channel ON cos_threads(channel_id)`,
    `ALTER TABLE cos_messages ADD COLUMN mentions_json TEXT`,
    `ALTER TABLE cos_messages ADD COLUMN slash_command TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_cos_messages_slash ON cos_messages(slash_command)`,
    // Bridge column linking a CoS thread back to the widget feedback that
    // spawned it. Populated by mintFeedbackThread; ON DELETE SET NULL so the
    // thread survives feedback purges. Indexed for the by-feedback lookup.
    `ALTER TABLE cos_threads ADD COLUMN feedback_id TEXT REFERENCES feedback_items(id) ON DELETE SET NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_threads_feedback ON cos_threads(feedback_id) WHERE feedback_id IS NOT NULL`,
    `ALTER TABLE agent_endpoints ADD COLUMN description TEXT`,
    `ALTER TABLE agent_endpoints ADD COLUMN source_session_ids TEXT`,
    // Monorepo sub-app support: a JSON registry of named subdirectories on the
    // application, and the sub-app each feedback item targets. Lets one app
    // (e.g. "Workbench") route dispatch to platform/dashboard, platform/gateway,
    // etc. instead of needing a separate app per package.
    `ALTER TABLE applications ADD COLUMN sub_apps TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE feedback_items ADD COLUMN sub_app TEXT`,
    `ALTER TABLE feedback_items ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE feedback_items ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_owner ON feedback_items(owner_user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_org ON feedback_items(org_id, created_at)`,
    `ALTER TABLE agent_sessions ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE agent_sessions ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner ON agent_sessions(owner_user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_org ON agent_sessions(org_id, created_at)`,
    // Phase 5: per-session isolation + metering.
    `ALTER TABLE agent_endpoints ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'`,
    `ALTER TABLE agent_sessions ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'`,
    `ALTER TABLE agent_sessions ADD COLUMN isolate_id TEXT`,
    `ALTER TABLE flatter_runs ADD COLUMN plan_id TEXT REFERENCES flatter_plans(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_flatter_runs_plan ON flatter_runs(plan_id, created_at)`,
  ];

  // NOTE: alterStatements are applied at the END of runMigrations(), after
  // ALL CREATE TABLE statements have run. This is intentional — many of the
  // ALTER targets (machines, harness_configs, sprite_configs, wiggum_*) are
  // created later in this function, so attempting the ALTER here would be a
  // no-op silently swallowed by the try/catch on a fresh DB.

  // Migration: make feedback_id and agent_endpoint_id nullable for plain terminal sessions
  try {
    sqlite.exec(`DROP TABLE IF EXISTS agent_sessions_new`);
    const info = sqlite.pragma(`table_info(agent_sessions)`) as { name: string; notnull: number }[];
    const feedbackCol = info.find(c => c.name === 'feedback_id');
    if (feedbackCol && feedbackCol.notnull === 1) {
      sqlite.exec(`
        CREATE TABLE agent_sessions_new (
          id TEXT PRIMARY KEY,
          feedback_id TEXT REFERENCES feedback_items(id) ON DELETE CASCADE,
          agent_endpoint_id TEXT REFERENCES agent_endpoints(id) ON DELETE CASCADE,
          runtime TEXT NOT NULL DEFAULT 'claude',
          permission_profile TEXT NOT NULL DEFAULT 'interactive-require',
          parent_session_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          pid INTEGER,
          exit_code INTEGER,
          output_log TEXT,
          output_bytes INTEGER NOT NULL DEFAULT 0,
          last_output_seq INTEGER NOT NULL DEFAULT 0,
          last_input_seq INTEGER NOT NULL DEFAULT 0,
          tmux_session_name TEXT,
          launcher_id TEXT,
          claude_session_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO agent_sessions_new (
          id, feedback_id, agent_endpoint_id, runtime, permission_profile,
          status, pid, exit_code, output_log, output_bytes,
          created_at, started_at, completed_at,
          parent_session_id, last_output_seq, last_input_seq,
          tmux_session_name, launcher_id
        )
        SELECT
          id, feedback_id, agent_endpoint_id, 'claude', permission_profile,
          status, pid, exit_code, output_log, output_bytes,
          created_at, started_at, completed_at,
          parent_session_id, last_output_seq, last_input_seq,
          tmux_session_name, launcher_id
        FROM agent_sessions;
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_feedback ON agent_sessions(feedback_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
      `);
    }
  } catch {
    // Migration already applied or table doesn't exist yet
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      seq_num INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_session_dir_seq
      ON pending_messages(session_id, direction, seq_num);
  `);

  // Follow-up prompts queued for yolo/headless sessions. Popped on parent exit.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_followups (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      feedback_id TEXT,
      agent_endpoint_id TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      dispatched_session_id TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_followups_parent_status
      ON session_followups(parent_session_id, status, created_at);
  `);

  // Perf metrics table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS perf_metrics (
      id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      durations TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_perf_metrics_route ON perf_metrics(route);
    CREATE INDEX IF NOT EXISTS idx_perf_metrics_created ON perf_metrics(created_at);
  `);

  // Tmux configs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tmux_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Machines table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT,
      address TEXT,
      type TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen_at TEXT,
      capabilities TEXT,
      tags TEXT,
      auth_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Harness configs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS harness_configs (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      app_image TEXT,
      app_port INTEGER,
      app_internal_port INTEGER,
      server_port INTEGER,
      browser_mcp_port INTEGER,
      target_app_url TEXT,
      compose_dir TEXT,
      env_vars TEXT,
      launcher_id TEXT,
      last_started_at TEXT,
      last_stopped_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_harness_configs_app ON harness_configs(app_id);
    CREATE INDEX IF NOT EXISTS idx_harness_configs_machine ON harness_configs(machine_id);
  `);

  // Sprite configs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sprite_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sprite_name TEXT NOT NULL,
      token TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      sprite_url TEXT,
      sprite_id TEXT,
      max_sessions INTEGER NOT NULL DEFAULT 3,
      default_cwd TEXT,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      last_checked_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sprite_configs_app ON sprite_configs(app_id);
  `);

  // Wiggum runs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiggum_runs (
      id TEXT PRIMARY KEY,
      agent_endpoint_id TEXT REFERENCES agent_endpoints(id) ON DELETE SET NULL,
      harness_config_id TEXT REFERENCES harness_configs(id) ON DELETE SET NULL,
      feedback_id TEXT REFERENCES feedback_items(id) ON DELETE SET NULL,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      deploy_command TEXT,
      max_iterations INTEGER NOT NULL DEFAULT 10,
      widget_session_id TEXT,
      screenshot_delay_ms INTEGER NOT NULL DEFAULT 3000,
      parent_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      current_iteration INTEGER NOT NULL DEFAULT 0,
      iterations TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wiggum_runs_status ON wiggum_runs(status);
    CREATE INDEX IF NOT EXISTS idx_wiggum_runs_harness ON wiggum_runs(harness_config_id);

    CREATE TABLE IF NOT EXISTS wiggum_screenshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES wiggum_runs(id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wiggum_screenshots_run ON wiggum_screenshots(run_id);
  `);

  // Add parent_session_id to wiggum_runs (meta-wiggum orchestration)
  try {
    sqlite.exec(`ALTER TABLE wiggum_runs ADD COLUMN parent_session_id TEXT`);
  } catch {
    // Column already exists
  }

  // FAFO: wiggum swarms table + swarm columns on wiggum_runs
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiggum_swarms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt_file TEXT,
      fitness_command TEXT,
      target_artifact TEXT,
      artifact_type TEXT NOT NULL DEFAULT 'screenshot',
      knowledge_file TEXT,
      knowledge_content TEXT NOT NULL DEFAULT '',
      fan_out INTEGER NOT NULL DEFAULT 6,
      generation_count INTEGER NOT NULL DEFAULT 0,
      harness_config_id TEXT REFERENCES harness_configs(id) ON DELETE SET NULL,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Multi-path sub-elements table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiggum_swarm_paths (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL REFERENCES wiggum_swarms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      files TEXT,
      focus_lines TEXT,
      crop_region TEXT,
      fitness_metric TEXT,
      fitness_command TEXT,
      worktree_port INTEGER,
      worktree_branch TEXT,
      worktree_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      "order" INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const swarmCols = [
    `ALTER TABLE wiggum_swarms ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'`,
    `ALTER TABLE wiggum_swarms ADD COLUMN fitness_metric TEXT NOT NULL DEFAULT 'pixel-diff'`,
    `ALTER TABLE wiggum_swarms ADD COLUMN isolation TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN swarm_id TEXT REFERENCES wiggum_swarms(id) ON DELETE SET NULL`,
    `ALTER TABLE wiggum_runs ADD COLUMN path_id TEXT REFERENCES wiggum_swarm_paths(id) ON DELETE SET NULL`,
    `ALTER TABLE wiggum_runs ADD COLUMN generation INTEGER`,
    `ALTER TABLE wiggum_runs ADD COLUMN parent_run_id TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN fitness_score REAL`,
    `ALTER TABLE wiggum_runs ADD COLUMN knobs TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN final_artifact_path TEXT`,
    `ALTER TABLE wiggum_runs ADD COLUMN survived INTEGER`,
    `ALTER TABLE wiggum_runs ADD COLUMN session_id TEXT`,
  ];
  for (const sql of swarmCols) {
    try { sqlite.exec(sql); } catch { /* column exists */ }
  }

  // Standalone screenshots table (not tied to feedback items)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      session_id TEXT,
      user_id TEXT,
      source_url TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_screenshots_app ON screenshots(app_id);
    CREATE INDEX IF NOT EXISTS idx_screenshots_created ON screenshots(created_at);
  `);

  // Standalone arbitrary-file uploads (drag-and-drop into the admin composer)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      session_id TEXT,
      user_id TEXT,
      source_url TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_uploads_app ON uploads(app_id);
    CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);
  `);

  // JSONL continuation tracking
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jsonl_continuations (
      child_session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      discovered_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jsonl_cont_parent
      ON jsonl_continuations(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_jsonl_cont_project
      ON jsonl_continuations(project_dir);
  `);

  // Voice ambient-listen sessions
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id TEXT PRIMARY KEY,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      widget_session_id TEXT,
      user_id TEXT,
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      stopped_at TEXT,
      stop_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_voice_sessions_status ON voice_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_app ON voice_sessions(app_id);

    CREATE TABLE IF NOT EXISTS voice_transcripts (
      id TEXT PRIMARY KEY,
      voice_session_id TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
      window_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      classification TEXT,
      feedback_id TEXT REFERENCES feedback_items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_voice_transcripts_session ON voice_transcripts(voice_session_id);

    CREATE TABLE IF NOT EXISTS pending_dispatches (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
      agent_endpoint_id TEXT REFERENCES agent_endpoints(id) ON DELETE SET NULL,
      app_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
      notification_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      dispatch_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'voice',
      metadata TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_dispatches_status ON pending_dispatches(status);
    CREATE INDEX IF NOT EXISTS idx_pending_dispatches_feedback ON pending_dispatches(feedback_id);

    CREATE TABLE IF NOT EXISTS cos_learnings (
      id TEXT PRIMARY KEY,
      session_jsonl TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cos_learnings_type ON cos_learnings(type);
    CREATE INDEX IF NOT EXISTS idx_cos_learnings_severity ON cos_learnings(severity);
    CREATE INDEX IF NOT EXISTS idx_cos_learnings_created ON cos_learnings(created_at);

    CREATE TABLE IF NOT EXISTS cos_learning_links (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES cos_learnings(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES cos_learnings(id) ON DELETE CASCADE,
      rel_type TEXT NOT NULL DEFAULT 'related',
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cos_learning_links_from ON cos_learning_links(from_id);
    CREATE INDEX IF NOT EXISTS idx_cos_learning_links_to ON cos_learning_links(to_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_learning_links_unique ON cos_learning_links(from_id, to_id, rel_type);

    CREATE TABLE IF NOT EXISTS cos_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // CoS channels (workspace-scoped thread buckets, with dispatch policy)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cos_channels (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'staging',
      policy_json TEXT NOT NULL DEFAULT '{}',
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_channels_app_slug ON cos_channels(app_id, slug);
    CREATE INDEX IF NOT EXISTS idx_cos_channels_app ON cos_channels(app_id);

    CREATE TABLE IF NOT EXISTS cos_channel_members (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES cos_channels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cos_channel_members_unique
      ON cos_channel_members(channel_id, kind, ref_id);
    CREATE INDEX IF NOT EXISTS idx_cos_channel_members_channel
      ON cos_channel_members(channel_id);

    CREATE TABLE IF NOT EXISTS cos_channel_org_proposals (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      proposal_json TEXT NOT NULL,
      reasoning TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_cos_channel_org_proposals_app
      ON cos_channel_org_proposals(app_id, status, created_at);

    CREATE TABLE IF NOT EXISTS cos_dispatch_approvals (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES cos_channels(id) ON DELETE CASCADE,
      feedback_id TEXT NOT NULL,
      agent_endpoint_id TEXT NOT NULL,
      instructions TEXT,
      permission_profile TEXT,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      deny_reason TEXT,
      dispatched_session_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cos_dispatch_approvals_channel
      ON cos_dispatch_approvals(channel_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_cos_dispatch_approvals_status
      ON cos_dispatch_approvals(status, created_at);
  `);

  // CoS threads and messages tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cos_threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      app_id TEXT,
      name TEXT NOT NULL,
      system_prompt TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cos_threads_agent ON cos_threads(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cos_threads_app ON cos_threads(app_id);
    CREATE INDEX IF NOT EXISTS idx_cos_threads_updated ON cos_threads(updated_at);

    CREATE TABLE IF NOT EXISTS cos_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES cos_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      tool_calls_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cos_messages_thread ON cos_messages(thread_id);

    CREATE TABLE IF NOT EXISTS cos_drafts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      app_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    -- The unique index on (agent_id, app_id, thread_id) is created in the
    -- alterStatements pass below, after the ADD COLUMN runs for legacy DBs
    -- that pre-date thread_id (otherwise the index would reference a column
    -- that doesn't exist yet on disk).

    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nfs_share TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      launcher_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      org_id TEXT,
      isolation TEXT NOT NULL DEFAULT 'shared',
      isolate_class TEXT,
      isolate_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      wall_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_est REAL,
      status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_usage_user ON session_usage(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_session_usage_org ON session_usage(org_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_session_usage_open ON session_usage(ended_at);
  `);

  // Seed default tmux config from tmux-pw.conf if table is empty or default has empty content
  function readTmuxPwConf(): string {
    // Try multiple relative paths since compiled JS runs from dist/db/
    const candidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmux-pw.conf'),
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tmux-pw.conf'),
      resolve(process.cwd(), 'tmux-pw.conf'),
    ];
    for (const p of candidates) {
      try { return readFileSync(p, 'utf-8'); } catch { /* next */ }
    }
    return '';
  }

  // Apply column-level migrations now that all CREATE TABLE statements
  // (including machines, harness_configs, sprite_configs, wiggum_*) have run.
  for (const stmt of alterStatements) {
    try {
      sqlite.exec(stmt);
    } catch {
      // Column already exists
    }
  }

  // Migrate permission profile names to the explicit two-axis scheme
  // (<mode>-<perms>). Every rename is idempotent: re-running after a partial
  // migration is a no-op because the new names aren't touched by either
  // pass.
  //
  // Rename pipeline (apply in order — each step's WHERE clause excludes the
  // previous step's output):
  //   legacy              → interim              → final (2026-04-23)
  //   auto                → headless             → headless-yolo
  //   yolo (headless)     → headless             → headless-yolo
  //   yolo (interactive)  → yolo                 → interactive-yolo
  //   interactive-yolo    → yolo                 → interactive-yolo
  //   interactive         → interactive          → interactive-require
  //   headless            → headless             → headless-yolo
  //   interactive-json    → interactive-json     → headless-stream-yolo
  try {
    sqlite.exec(`
      -- Step 1: legacy → interim (2026-04-09 rename).
      UPDATE agent_endpoints SET permission_profile = 'headless'
        WHERE permission_profile IN ('auto', 'yolo-legacy');
      UPDATE agent_endpoints SET permission_profile = 'yolo'
        WHERE permission_profile = 'interactive-yolo';
      UPDATE agent_sessions SET permission_profile = 'headless'
        WHERE permission_profile IN ('auto', 'yolo-legacy');
      UPDATE agent_sessions SET permission_profile = 'yolo'
        WHERE permission_profile = 'interactive-yolo';
      UPDATE applications SET default_permission_profile = 'headless'
        WHERE default_permission_profile IN ('auto', 'yolo-legacy');
      UPDATE applications SET default_permission_profile = 'yolo'
        WHERE default_permission_profile = 'interactive-yolo';

      -- Step 2: interim → two-axis final (2026-04-23 rename).
      UPDATE agent_endpoints SET permission_profile = 'interactive-require'
        WHERE permission_profile = 'interactive';
      UPDATE agent_endpoints SET permission_profile = 'interactive-yolo'
        WHERE permission_profile = 'yolo';
      UPDATE agent_endpoints SET permission_profile = 'headless-yolo'
        WHERE permission_profile = 'headless';
      UPDATE agent_endpoints SET permission_profile = 'headless-stream-yolo'
        WHERE permission_profile = 'interactive-json';

      UPDATE agent_sessions SET permission_profile = 'interactive-require'
        WHERE permission_profile = 'interactive';
      UPDATE agent_sessions SET permission_profile = 'interactive-yolo'
        WHERE permission_profile = 'yolo';
      UPDATE agent_sessions SET permission_profile = 'headless-yolo'
        WHERE permission_profile = 'headless';
      UPDATE agent_sessions SET permission_profile = 'headless-stream-yolo'
        WHERE permission_profile = 'interactive-json';

      UPDATE applications SET default_permission_profile = 'interactive-require'
        WHERE default_permission_profile = 'interactive';
      UPDATE applications SET default_permission_profile = 'interactive-yolo'
        WHERE default_permission_profile = 'yolo';
      UPDATE applications SET default_permission_profile = 'headless-yolo'
        WHERE default_permission_profile = 'headless';
      UPDATE applications SET default_permission_profile = 'headless-stream-yolo'
        WHERE default_permission_profile = 'interactive-json';

      -- Step 3: endpoints literally named "yolo" / "codex-yolo" were seeded
      -- with permission_profile='headless-yolo' (batch pipe mode) but users
      -- expect them to behave like the YOLO button (TTY + skip). Realign so
      -- picker-selection matches button-click.
      UPDATE agent_endpoints SET permission_profile = 'interactive-yolo'
        WHERE name IN ('yolo', 'codex-yolo')
          AND permission_profile = 'headless-yolo';

      -- Step 4: drop the legacy "consider screenshots if available in
      -- feedback." trailing line from any agent prompt template that still
      -- has it. Screenshots are now inlined as /tmp paths via [Image N]
      -- markers in the feedback description, so the boilerplate prefix is
      -- pure noise. We only strip the suffix; if a user has further
      -- customised the template the rest is preserved.
      UPDATE agent_endpoints
         SET prompt_template = TRIM(
               SUBSTR(prompt_template, 1,
                      LENGTH(prompt_template)
                        - LENGTH(char(10) || char(10)
                                 || 'consider screenshots if available in feedback.'))
             )
       WHERE prompt_template LIKE '%' || char(10) || char(10)
                                || 'consider screenshots if available in feedback.';

      -- Step 5: endpoints stuck on the schema's mode default ('webhook')
      -- with no URL can never dispatch ("Agent endpoint has mode webhook
      -- but no URL configured"). They were always meant to spawn sessions —
      -- realign mode with the permission profile.
      UPDATE agent_endpoints SET mode = 'headless'
        WHERE mode = 'webhook' AND (url IS NULL OR url = '')
          AND permission_profile LIKE 'headless%';
      UPDATE agent_endpoints SET mode = 'interactive'
        WHERE mode = 'webhook' AND (url IS NULL OR url = '');
    `);
  } catch {
    // Tables/columns may not all exist on very fresh DBs; alter statements
    // above are idempotent and re-running this migration on a clean DB is a
    // no-op.
  }

  // Backfill agent_session_id on existing cos_threads that already have a
  // linked agent_sessions row (from the old upsert-per-turn logic).
  try {
    const orphanThreads = sqlite.prepare(
      `SELECT t.id AS threadId, s.id AS sessionId
       FROM cos_threads t
       JOIN agent_sessions s ON s.cos_thread_id = t.id
       WHERE t.agent_session_id IS NULL
       ORDER BY s.created_at ASC`
    ).all() as { threadId: string; sessionId: string }[];
    for (const row of orphanThreads) {
      sqlite.prepare(`UPDATE cos_threads SET agent_session_id = ? WHERE id = ? AND agent_session_id IS NULL`)
        .run(row.sessionId, row.threadId);
    }
  } catch { /* table may not exist yet on very fresh DBs */ }

  // Unify ticket/session/thread linkage: pre-bi-directional-link dispatches
  // wrote agent_sessions.feedback_id but never agent_sessions.cos_thread_id,
  // so the conversation in the CoS bubble couldn't surface the session log
  // for the dispatched run. Walk every dispatched session whose feedback has
  // a minted cos_thread, and link the two. Then run the inverse pass: for any
  // cos_threads that still have no agent_session_id but now have a backing
  // session via cos_thread_id, set agent_session_id to the latest such row.
  // Both passes are idempotent (re-running is a no-op once linkage is in).
  try {
    sqlite.exec(`
      UPDATE agent_sessions
         SET cos_thread_id = (
           SELECT t.id FROM cos_threads t
           WHERE t.feedback_id = agent_sessions.feedback_id
           LIMIT 1
         )
       WHERE cos_thread_id IS NULL
         AND feedback_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM cos_threads t WHERE t.feedback_id = agent_sessions.feedback_id
         );
    `);
    const stillOrphanThreads = sqlite.prepare(
      `SELECT t.id AS threadId, (
         SELECT s.id FROM agent_sessions s
         WHERE s.cos_thread_id = t.id
         ORDER BY s.created_at DESC LIMIT 1
       ) AS sessionId
       FROM cos_threads t
       WHERE t.agent_session_id IS NULL
         AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.cos_thread_id = t.id)`
    ).all() as { threadId: string; sessionId: string | null }[];
    for (const row of stillOrphanThreads) {
      if (!row.sessionId) continue;
      sqlite.prepare(
        `UPDATE cos_threads SET agent_session_id = ? WHERE id = ? AND agent_session_id IS NULL`
      ).run(row.sessionId, row.threadId);
    }
  } catch (err) {
    console.error('[db] dispatched-session/thread backfill failed', err);
  }

  // Provision a persistent headless-stream agent session for any cos_threads
  // that still have none. Post-this-migration every CoS thread shows up as
  // exactly one session row in the sessions list under the CoS hierarchy,
  // even threads created before the auto-provision logic landed.
  try {
    const threadsMissingSession = sqlite.prepare(
      `SELECT id, name FROM cos_threads WHERE agent_session_id IS NULL`
    ).all() as { id: string; name: string }[];
    // Repo root: server runs from packages/server, so process.cwd() + ../..
    // lands at the project root. Mirrors resolveRepoRoot() in chief-of-staff.ts.
    const cwd = resolve(process.cwd(), '..', '..');
    for (const t of threadsMissingSession) {
      const sessionId = ulid();
      const nowIso = new Date().toISOString();
      sqlite.prepare(
        `INSERT INTO agent_sessions
           (id, cos_thread_id, runtime, permission_profile, status, output_bytes, last_output_seq, last_input_seq,
            title, cwd, created_at, started_at, last_activity_at)
         VALUES (?, ?, 'claude', 'headless-stream-yolo', 'idle', 0, 0, 0, ?, ?, ?, ?, ?)`
      ).run(sessionId, t.id, t.name, cwd, nowIso, nowIso, nowIso);
      sqlite.prepare(`UPDATE cos_threads SET agent_session_id = ? WHERE id = ?`)
        .run(sessionId, t.id);
    }
  } catch { /* non-fatal — tables may not exist yet on fresh DBs */ }

  // Normalize profile on CoS-linked sessions: the persistent chat path is
  // always headless-stream-yolo. Older rows may have the legacy headless-yolo
  // (one-shot pipe) or interactive-yolo (TTY) profile from the removed
  // direct-spawn fallback; fix them so the sessions list reflects reality.
  try {
    sqlite.exec(`
      UPDATE agent_sessions
         SET permission_profile = 'headless-stream-yolo'
       WHERE cos_thread_id IS NOT NULL
         AND permission_profile IN ('headless-yolo', 'interactive-yolo');
    `);
  } catch { /* non-fatal */ }

  const configCount = sqlite.prepare('SELECT count(*) as cnt FROM tmux_configs').get() as { cnt: number };
  if (configCount.cnt === 0) {
    const now = new Date().toISOString();
    sqlite.prepare(
      'INSERT INTO tmux_configs (id, name, content, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
    ).run(ulid(), 'Default', readTmuxPwConf(), now, now);
  } else {
    // Re-seed if default row exists but has empty content (path was wrong on first run)
    const defaultRow = sqlite.prepare('SELECT id, content FROM tmux_configs WHERE is_default = 1').get() as { id: string; content: string } | undefined;
    if (defaultRow && defaultRow.content === '') {
      const content = readTmuxPwConf();
      if (content) {
        sqlite.prepare('UPDATE tmux_configs SET content = ?, updated_at = ? WHERE id = ?')
          .run(content, new Date().toISOString(), defaultRow.id);
      }
    }
  }
}
