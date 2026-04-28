import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  projectDir: text('project_dir').notNull(),
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
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
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
  claudeSessionId: text('claude_session_id'),
  companionSessionId: text('companion_session_id'),
  cwd: text('cwd'),
  spriteConfigId: text('sprite_config_id'),
  spriteExecSessionId: text('sprite_exec_session_id'),
  cosThreadId: text('cos_thread_id'),
  title: text('title'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  lastActivityAt: text('last_activity_at'),
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

// Scheduled dispatches that fire after a delay unless cancelled. Used by
// voice-mode to give the user a 10s undo window before an agent spins up.
export const cosThreads = sqliteTable('cos_threads', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  appId: text('app_id'),
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
