import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  projectDir: text('project_dir').notNull(),
  // JSON array of { name, dir, description?, subdomain? } describing the
  // monorepo sub-apps that feedback for this app can target. Empty for
  // single-package apps.
  subApps: text('sub_apps').notNull().default('[]'),
  serverUrl: text('server_url'),
  hooks: text('hooks').notNull().default('[]'),
  description: text('description').notNull().default(''),
  tmuxConfigId: text('tmux_config_id'),
  defaultPermissionProfile: text('default_permission_profile').default('interactive-require'),
  defaultAllowedTools: text('default_allowed_tools'),
  agentPath: text('agent_path'),
  screenshotIncludeWidget: integer('screenshot_include_widget', { mode: 'boolean' }).notNull().default(true),
  autoDispatch: integer('auto_dispatch', { mode: 'boolean' }).notNull().default(true),
  controlActions: text('control_actions').notNull().default('[]'),
  requestPanel: text('request_panel').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const feedbackItems = sqliteTable('feedback_items', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('manual'),
  status: text('status').notNull().default('new'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  data: text('data'),
  context: text('context'),
  sourceUrl: text('source_url'),
  userAgent: text('user_agent'),
  viewport: text('viewport'),
  sessionId: text('session_id'),
  userId: text('user_id'),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  orgId: text('org_id').references(() => orgs.id, { onDelete: 'set null' }),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  // Sub-app of the monorepo this feedback targets (matched against the app's
  // subApps registry). Null for single-package apps.
  subApp: text('sub_app'),
  dispatchedTo: text('dispatched_to'),
  dispatchedAt: text('dispatched_at'),
  dispatchStatus: text('dispatch_status'),
  dispatchResponse: text('dispatch_response'),
  titleHistory: text('title_history').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const feedbackScreenshots = sqliteTable('feedback_screenshots', {
  id: text('id').primaryKey(),
  feedbackId: text('feedback_id')
    .notNull()
    .references(() => feedbackItems.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
});

export const screenshots = sqliteTable('screenshots', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  sessionId: text('session_id'),
  userId: text('user_id'),
  sourceUrl: text('source_url'),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
});

// Standalone arbitrary-file uploads (drag-and-drop into the admin composer).
export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  sessionId: text('session_id'),
  userId: text('user_id'),
  sourceUrl: text('source_url'),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
});

export const feedbackAudio = sqliteTable('feedback_audio', {
  id: text('id').primaryKey(),
  feedbackId: text('feedback_id')
    .notNull()
    .references(() => feedbackItems.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  duration: integer('duration').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const feedbackTags = sqliteTable('feedback_tags', {
  feedbackId: text('feedback_id')
    .notNull()
    .references(() => feedbackItems.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
});

export const agentEndpoints = sqliteTable('agent_endpoints', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull().default(''),
  authHeader: text('auth_header'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  promptTemplate: text('prompt_template'),
  mode: text('mode').notNull().default('webhook'),
  runtime: text('runtime').notNull().default('claude'),
  permissionProfile: text('permission_profile').notNull().default('interactive-require'),
  allowedTools: text('allowed_tools'),
  autoPlan: integer('auto_plan', { mode: 'boolean' }).notNull().default(false),
  preferredLauncherId: text('preferred_launcher_id'),
  harnessConfigId: text('harness_config_id'),
  spriteConfigId: text('sprite_config_id'),
  description: text('description'),
  sourceSessionIds: text('source_session_ids'),
  // Phase 5 — isolation is a property of the agent type chosen at launch.
  //   'shared'        — today's behavior; the launcher's own agent-home.
  //   'per_user_pod'  — the owner's long-lived per-user pod (phase 4).
  //   'per_session'   — a fresh ephemeral isolate created at dispatch and torn
  //                     down at session end (git-worktree substrate, first cut).
  isolation: text('isolation').notNull().default('shared'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  groupKey: text('group_key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  status: text('status').notNull().default('draft'),
  linkedFeedbackIds: text('linked_feedback_ids').notNull().default('[]'),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flatterMonitors = sqliteTable('flatter_monitors', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull(),
  branch: text('branch').notNull().default('main'),
  baselineRef: text('baseline_ref'),
  baselineDate: text('baseline_date'),
  focusJson: text('focus_json').notNull().default('{}'),
  lastHeadSha: text('last_head_sha'),
  lastScannedAt: text('last_scanned_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flatterReports = sqliteTable('flatter_reports', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  monitorId: text('monitor_id').notNull().references(() => flatterMonitors.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  upstreamHeadSha: text('upstream_head_sha'),
  baselineSummary: text('baseline_summary'),
  summary: text('summary').notNull().default(''),
  statsJson: text('stats_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flatterItems = sqliteTable('flatter_items', {
  id: text('id').primaryKey(),
  reportId: text('report_id').notNull().references(() => flatterReports.id, { onDelete: 'cascade' }),
  monitorId: text('monitor_id').notNull().references(() => flatterMonitors.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('commit'),
  upstreamRef: text('upstream_ref'),
  upstreamUrl: text('upstream_url'),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  category: text('category').notNull().default('nice'),
  relevance: text('relevance').notNull().default('medium'),
  risk: text('risk').notNull().default('medium'),
  status: text('status').notNull().default('proposed'),
  rationale: text('rationale').notNull().default(''),
  scopeNotes: text('scope_notes').notNull().default(''),
  operatorNotes: text('operator_notes').notNull().default(''),
  payloadJson: text('payload_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flatterPlans = sqliteTable('flatter_plans', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  reportId: text('report_id').references(() => flatterReports.id, { onDelete: 'set null' }),
  planningFeedbackId: text('planning_feedback_id').references(() => feedbackItems.id, { onDelete: 'set null' }),
  planningSessionId: text('planning_session_id'),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  status: text('status').notNull().default('ready'),
  itemsJson: text('items_json').notNull().default('[]'),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flatterRuns = sqliteTable('flatter_runs', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => flatterItems.id, { onDelete: 'cascade' }),
  planId: text('plan_id').references(() => flatterPlans.id, { onDelete: 'set null' }),
  label: text('label').notNull(),
  status: text('status').notNull().default('pending'),
  columnsJson: text('columns_json').notNull().default('[]'),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  feedbackId: text('feedback_id')
    .references(() => feedbackItems.id, { onDelete: 'cascade' }),
  agentEndpointId: text('agent_endpoint_id')
    .references(() => agentEndpoints.id, { onDelete: 'cascade' }),
  runtime: text('runtime').notNull().default('claude'),
  permissionProfile: text('permission_profile').notNull().default('interactive-require'),
  parentSessionId: text('parent_session_id'),
  status: text('status').notNull().default('pending'),
  pid: integer('pid'),
  exitCode: integer('exit_code'),
  outputLog: text('output_log'),
  outputBytes: integer('output_bytes').notNull().default(0),
  lastOutputSeq: integer('last_output_seq').notNull().default(0),
  lastInputSeq: integer('last_input_seq').notNull().default(0),
  tmuxSessionName: text('tmux_session_name'),
  launcherId: text('launcher_id'),
  machineId: text('machine_id'),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  orgId: text('org_id').references(() => orgs.id, { onDelete: 'set null' }),
  claudeSessionId: text('claude_session_id'),
  companionSessionId: text('companion_session_id'),
  cwd: text('cwd'),
  spriteConfigId: text('sprite_config_id'),
  spriteExecSessionId: text('sprite_exec_session_id'),
  cosThreadId: text('cos_thread_id'),
  title: text('title'),
  // Phase 5 — the isolation mode this session actually ran in, and the id of
  // the ephemeral isolate (git-worktree path token) when isolation='per_session'.
  isolation: text('isolation').notNull().default('shared'),
  isolateId: text('isolate_id'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  lastActivityAt: text('last_activity_at'),
});

// Phase 5 — per-session usage meter. One row per dispatched session, tagged
// with owner/org and the isolate it ran in. Wall time is finalized from the
// session's terminal state (reconcile-on-read + a periodic sweep); token/cost
// columns are the substrate for a future Propanes-as-a-service billing ledger
// and are left null until the runtime exposes per-session accounting.
export const sessionUsage = sqliteTable('session_usage', {
  // Keyed by sessionId so begin is idempotent (INSERT OR IGNORE).
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id'),
  orgId: text('org_id'),
  isolation: text('isolation').notNull().default('shared'),
  isolateClass: text('isolate_class'), // 'shared' | 'per_user_pod' | 'worktree'
  isolateId: text('isolate_id'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  wallMs: integer('wall_ms'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costEst: real('cost_est'),
  status: text('status'),
  createdAt: text('created_at').notNull(),
});

export const tmuxConfigs = sqliteTable('tmux_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const machines = sqliteTable('machines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname'),
  address: text('address'),
  type: text('type').notNull().default('local'),
  status: text('status').notNull().default('offline'),
  defaultCwd: text('default_cwd'),
  lastSeenAt: text('last_seen_at'),
  capabilities: text('capabilities'),
  tags: text('tags'),
  authToken: text('auth_token'),
  adminUrl: text('admin_url'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const harnessConfigs = sqliteTable('harness_configs', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  machineId: text('machine_id').references(() => machines.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('stopped'),
  appImage: text('app_image'),
  appPort: integer('app_port'),
  appInternalPort: integer('app_internal_port'),
  serverPort: integer('server_port'),
  browserMcpPort: integer('browser_mcp_port'),
  targetAppUrl: text('target_app_url'),
  composeDir: text('compose_dir'),
  envVars: text('env_vars'),
  hostTerminalAccess: integer('host_terminal_access', { mode: 'boolean' }).notNull().default(false),
  claudeHomePath: text('claude_home_path'),
  anthropicApiKey: text('anthropic_api_key'),
  launcherId: text('launcher_id'),
  lastStartedAt: text('last_started_at'),
  lastStoppedAt: text('last_stopped_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const spriteConfigs = sqliteTable('sprite_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  spriteName: text('sprite_name').notNull(),
  token: text('token'),
  status: text('status').notNull().default('unknown'),
  spriteUrl: text('sprite_url'),
  spriteId: text('sprite_id'),
  maxSessions: integer('max_sessions').notNull().default(3),
  defaultCwd: text('default_cwd'),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  lastCheckedAt: text('last_checked_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const perfMetrics = sqliteTable('perf_metrics', {
  id: text('id').primaryKey(),
  route: text('route').notNull(),
  durations: text('durations').notNull(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
});

export const jsonlContinuations = sqliteTable('jsonl_continuations', {
  childSessionId: text('child_session_id').primaryKey(),
  parentSessionId: text('parent_session_id').notNull(),
  projectDir: text('project_dir').notNull(),
  discoveredAt: text('discovered_at').notNull(),
});

export const wiggumSwarms = sqliteTable('wiggum_swarms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mode: text('mode').notNull().default('single'), // 'single' | 'multi-path'
  promptFile: text('prompt_file'),
  fitnessCommand: text('fitness_command'),
  targetArtifact: text('target_artifact'),
  artifactType: text('artifact_type').notNull().default('screenshot'),
  fitnessMetric: text('fitness_metric').notNull().default('pixel-diff'), // 'pixel-diff' | 'ssim' | 'edge-diff' | 'custom'
  knowledgeFile: text('knowledge_file'),
  knowledgeContent: text('knowledge_content').notNull().default(''),
  fanOut: integer('fan_out').notNull().default(6),
  generationCount: integer('generation_count').notNull().default(0),
  maxGenerations: integer('max_generations'),  // null = manual only; set to N to auto-advance up to gen N
  harnessConfigId: text('harness_config_id').references(() => harnessConfigs.id, { onDelete: 'set null' }),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  // Isolation config (JSON): { method: 'worktree'|'none', basePort?: number, baseBranch?: string }
  isolation: text('isolation'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Multi-path sub-elements within a swarm
export const wiggumSwarmPaths = sqliteTable('wiggum_swarm_paths', {
  id: text('id').primaryKey(),
  swarmId: text('swarm_id').notNull().references(() => wiggumSwarms.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // e.g. 'port-shape', 'pill-connector'
  prompt: text('prompt').notNull(), // per-path prompt for the child agent
  files: text('files'), // JSON array of file paths this path focuses on
  focusLines: text('focus_lines'), // e.g. '4706-4780'
  // Per-path fitness: crop region [x, y, w, h], metric override
  cropRegion: text('crop_region'), // JSON: [x, y, w, h]
  fitnessMetric: text('fitness_metric'), // override swarm-level metric
  fitnessCommand: text('fitness_command'), // override swarm-level command
  worktreePort: integer('worktree_port'), // assigned port for this path's vite
  worktreeBranch: text('worktree_branch'), // branch name for this path's worktree
  worktreePath: text('worktree_path'), // filesystem path to worktree
  status: text('status').notNull().default('pending'),
  order: integer('order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const wiggumRuns = sqliteTable('wiggum_runs', {
  id: text('id').primaryKey(),
  agentEndpointId: text('agent_endpoint_id').references(() => agentEndpoints.id, { onDelete: 'set null' }),
  harnessConfigId: text('harness_config_id').references(() => harnessConfigs.id, { onDelete: 'set null' }),
  feedbackId: text('feedback_id').references(() => feedbackItems.id, { onDelete: 'set null' }),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  prompt: text('prompt').notNull(),
  deployCommand: text('deploy_command'),
  maxIterations: integer('max_iterations').notNull().default(10),
  widgetSessionId: text('widget_session_id'),
  screenshotDelayMs: integer('screenshot_delay_ms').notNull().default(3000),
  parentSessionId: text('parent_session_id'),
  status: text('status').notNull().default('pending'),
  currentIteration: integer('current_iteration').notNull().default(0),
  iterations: text('iterations').notNull().default('[]'),
  errorMessage: text('error_message'),
  promptFile: text('prompt_file'),
  logFile: text('log_file'),
  agentLabel: text('agent_label'),
  swarmId: text('swarm_id').references(() => wiggumSwarms.id, { onDelete: 'set null' }),
  pathId: text('path_id').references(() => wiggumSwarmPaths.id, { onDelete: 'set null' }),
  generation: integer('generation'),
  parentRunId: text('parent_run_id'),
  fitnessScore: real('fitness_score'),
  fitnessDetail: text('fitness_detail'),
  knobs: text('knobs'),
  finalArtifactPath: text('final_artifact_path'),
  survived: integer('survived', { mode: 'boolean' }),
  sessionId: text('session_id'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const wiggumScreenshots = sqliteTable('wiggum_screenshots', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => wiggumRuns.id, { onDelete: 'cascade' }),
  iteration: integer('iteration').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
});

export const fafoFeedback = sqliteTable('fafo_feedback', {
  id: text('id').primaryKey(),
  swarmId: text('swarm_id').notNull().references(() => wiggumSwarms.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => wiggumRuns.id, { onDelete: 'set null' }),
  generation: integer('generation'),
  rating: integer('rating'), // -1 (bad), 0 (neutral), 1 (good)
  annotation: text('annotation'),
  regionX: integer('region_x'),
  regionY: integer('region_y'),
  regionW: integer('region_w'),
  regionH: integer('region_h'),
  screenshotRef: text('screenshot_ref'),
  createdAt: text('created_at').notNull(),
});

export const pendingMessages = sqliteTable('pending_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  direction: text('direction').notNull(), // 'output' | 'input'
  seqNum: integer('seq_num').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

// Follow-up prompts queued for yolo/headless sessions. When the parent
// session dies (completed or failed), the next pending entry is popped and
// dispatched as a --resume, carrying over the parent's claudeSessionId so
// the conversation continues. Built to let users queue work on a session
// they know will exit before they can respond interactively.
export const sessionFollowups = sqliteTable('session_followups', {
  id: text('id').primaryKey(),
  parentSessionId: text('parent_session_id').notNull(),
  feedbackId: text('feedback_id'),
  agentEndpointId: text('agent_endpoint_id'),
  prompt: text('prompt').notNull(),
  status: text('status').notNull().default('pending'), // pending | dispatched | canceled | failed
  createdAt: text('created_at').notNull(),
  dispatchedAt: text('dispatched_at'),
  dispatchedSessionId: text('dispatched_session_id'),
  errorMessage: text('error_message'),
});

// Ambient voice listen-mode sessions. One row per time the user flips on
// listen mode; rolling transcript windows are stored in voiceTranscripts.
export const voiceSessions = sqliteTable('voice_sessions', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  widgetSessionId: text('widget_session_id'),
  userId: text('user_id'),
  sourceUrl: text('source_url'),
  status: text('status').notNull().default('active'), // 'active' | 'stopped'
  startedAt: text('started_at').notNull(),
  lastActivityAt: text('last_activity_at').notNull(),
  stoppedAt: text('stopped_at'),
  stopReason: text('stop_reason'),
});

export const voiceTranscripts = sqliteTable('voice_transcripts', {
  id: text('id').primaryKey(),
  voiceSessionId: text('voice_session_id')
    .notNull()
    .references(() => voiceSessions.id, { onDelete: 'cascade' }),
  windowIndex: integer('window_index').notNull(),
  text: text('text').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  classification: text('classification'), // JSON { actionable, title, description, reason }
  feedbackId: text('feedback_id').references(() => feedbackItems.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
});

// Wiggum self-reflection: learnings extracted from past CoS sessions.
export const cosLearnings = sqliteTable('cos_learnings', {
  id: text('id').primaryKey(),
  sessionJsonl: text('session_jsonl'), // path to source JSONL file
  type: text('type').notNull(), // 'pitfall' | 'suggestion' | 'tool_gap'
  title: text('title').notNull(),
  body: text('body').notNull(),
  severity: text('severity').notNull().default('medium'), // 'low' | 'medium' | 'high'
  tags: text('tags'), // JSON string[] (nullable; defaults to [] in API)
  createdAt: integer('created_at').notNull(),
});

// Edges in the learnings knowledge graph. Each row is a directed link
// from one learning to another with a typed relationship.
export const cosLearningLinks = sqliteTable('cos_learning_links', {
  id: text('id').primaryKey(),
  fromId: text('from_id').notNull().references(() => cosLearnings.id, { onDelete: 'cascade' }),
  toId: text('to_id').notNull().references(() => cosLearnings.id, { onDelete: 'cascade' }),
  // 'related' | 'caused_by' | 'resolved_by' | 'duplicate_of'
  relType: text('rel_type').notNull().default('related'),
  // 'wiggum' (auto by reflection agent), 'auto' (server-side similarity), 'user' (manual)
  source: text('source').notNull().default('user'),
  createdAt: integer('created_at').notNull(),
});

// Generic key/value scratchpad used by Wiggum (e.g. lastReflectedAt).
export const cosMetadata = sqliteTable('cos_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Slack-style channel: a per-workspace (app) bucket of threads with a
// `policyJson` blob that gates dispatch (allowed permission profiles, agent
// allowlist, approval requirement, classification badge). Channels are the
// primary navigation unit in the admin sidebar — `appId` selects workspace,
// `slug` selects channel, threads live inside.
//
// `kind` is a coarse classification surfaced as a UI badge (red=prod,
// yellow=staging, green=exploratory). The actual enforcement lives in
// `policyJson` so operators can deviate from the defaults per channel.
export const cosChannels = sqliteTable('cos_channels', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  kind: text('kind').notNull().default('staging'), // 'prod' | 'staging' | 'exploratory'
  // ChannelPolicy: { classification, allowedProfiles[], allowedAgentIds|null,
  //                  requireApproval, pathGuards[], powwow:{enabled,providers[]},
  //                  retention:{archiveAfterDays?} }
  policyJson: text('policy_json').notNull().default('{}'),
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Explicit channel membership. `kind` distinguishes operator users (refId =
// user_id / email) from agent endpoints (refId = agent_endpoints.id). Used to
// resolve @mentions and to render the right-rail member list.
export const cosChannelMembers = sqliteTable('cos_channel_members', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => cosChannels.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // 'user' | 'agent'
  refId: text('ref_id').notNull(),
  role: text('role').notNull().default('member'), // 'owner' | 'member'
  joinedAt: integer('joined_at').notNull(),
});

// Pending dispatches that hit a `requireApproval` channel policy. The dispatch
// route inserts a row instead of spawning when policy.requireApproval is set;
// operators triage these from the Approvals queue and either approve (replays
// the saved payload via dispatchFeedbackToAgent) or deny.
export const cosDispatchApprovals = sqliteTable('cos_dispatch_approvals', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => cosChannels.id, { onDelete: 'cascade' }),
  feedbackId: text('feedback_id').notNull(),
  agentEndpointId: text('agent_endpoint_id').notNull(),
  instructions: text('instructions'),
  permissionProfile: text('permission_profile'),
  requestedBy: text('requested_by'),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'expired'
  denyReason: text('deny_reason'),
  dispatchedSessionId: text('dispatched_session_id'),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
  resolvedBy: text('resolved_by'),
});

// Reviewable proposals from the auto-organize endpoint: the LLM produces a
// channel structure (slugs/names/kinds) with thread assignments; the operator
// previews and approves before commit. `proposalJson` shape:
// { channels:[{slug,name,description,kind,threadIds:[]}], reasoning?:string }
export const cosChannelOrgProposals = sqliteTable('cos_channel_org_proposals', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // 'pending' | 'applied' | 'rejected'
  proposalJson: text('proposal_json').notNull(),
  reasoning: text('reasoning').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  appliedAt: integer('applied_at'),
});

// Scheduled dispatches that fire after a delay unless cancelled. Used by
// voice-mode to give the user a 10s undo window before an agent spins up.
export const cosThreads = sqliteTable('cos_threads', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  appId: text('app_id'),
  // Channel binding. Nullable during the migration window — threads created
  // before channels existed live in #general (back-fill on first run).
  channelId: text('channel_id').references(() => cosChannels.id, { onDelete: 'set null' }),
  // Bridge link from a widget/admin-submitted feedback item to its canonical
  // thread in the per-app inbox channel. Set by mintFeedbackThread on feedback
  // insert; null for organic CoS threads. ON DELETE SET NULL keeps the thread
  // alive if the feedback row is purged so the conversation history survives.
  feedbackId: text('feedback_id').references(() => feedbackItems.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt'),
  model: text('model'),
  claudeSessionId: text('claude_session_id'),
  agentSessionId: text('agent_session_id'),
  // In-flight turn bookkeeping. Set when a turn starts, cleared when it ends.
  // Survives main-server restarts so the frontend can poll status / re-attach
  // to an ongoing turn instead of surfacing a spurious "network error" when
  // the SSE stream drops.
  turnStartedAt: integer('turn_started_at'),
  turnStartSeq: integer('turn_start_seq'),
  turnUserText: text('turn_user_text'),
  turnRequestId: text('turn_request_id'),
  // Operator-set "this thread is done, hide it from triage". Null = open.
  // Set via PATCH /chief-of-staff/threads/:id { resolved: true }; cleared by
  // passing { resolved: false }. Independent of the underlying agent session
  // status — a failed session can be resolved (acknowledged), and an idle
  // session can be re-opened.
  resolvedAt: integer('resolved_at'),
  // Operator-set "stash this further away" — archived threads are hidden from
  // both the chat scroll and the rail by default. Reopen via { archived: false }.
  // Independent of resolvedAt; archiving implicitly resolves but reopening an
  // archived thread restores it to whatever resolved state it had.
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const cosMessages = sqliteTable('cos_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => cosThreads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  text: text('text').notNull(),
  toolCallsJson: text('tool_calls_json'),
  // JSON: { images?: [{dataUrl, name?, mimeType?}], elements?: [CosElementRef, ...] }
  attachmentsJson: text('attachments_json'),
  // Parsed @mention list: [{kind:'user'|'agent'|'channel', refId, charStart, charEnd}]
  mentionsJson: text('mentions_json'),
  // Leading slash command if the message starts with one (e.g. '/dispatch',
  // '/agent', '/powwow'). Null for plain chat messages.
  slashCommand: text('slash_command'),
  createdAt: integer('created_at').notNull(),
});

// Per-(agent, app, thread) operator draft for the CoS compose textarea. The
// scope is three-dimensional: agent picks the persona tab, app picks the
// product the operator is looking at, threadId scopes to a specific in-thread
// reply ('' = the top-level "new thread" compose draft, anything else = a
// reply-in-thread draft). Switching the reply-pill scope swaps which row
// hydrates the textarea, so the operator never loses an in-progress reply
// when they jump between threads. Empty rows are deleted rather than
// persisted, so presence == "this scope has unsent text".
export const cosDrafts = sqliteTable('cos_drafts', {
  // Synthetic key so drizzle has a primary column; the lookup index is on
  // (agentId, appId, threadId) via a unique constraint enforced in migrations.
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  appId: text('app_id').notNull().default(''),
  threadId: text('thread_id').notNull().default(''),
  text: text('text').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
});

export const pendingDispatches = sqliteTable('pending_dispatches', {
  id: text('id').primaryKey(),
  feedbackId: text('feedback_id')
    .notNull()
    .references(() => feedbackItems.id, { onDelete: 'cascade' }),
  agentEndpointId: text('agent_endpoint_id').references(() => agentEndpoints.id, { onDelete: 'set null' }),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  notificationId: text('notification_id'),
  status: text('status').notNull().default('pending'), // 'pending' | 'dispatched' | 'cancelled'
  dispatchAt: text('dispatch_at').notNull(),
  source: text('source').notNull().default('voice'), // 'voice' | other
  metadata: text('metadata'), // JSON bag
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nfsShare: text('nfs_share'),
  createdAt: text('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => orgs.id, { onDelete: 'set null' }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('active'),
  launcherId: text('launcher_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
