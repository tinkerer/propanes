import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  projectDir: text('project_dir').notNull(),
  serverUrl: text('server_url'),
  hooks: text('hooks').notNull().default('[]'),
  description: text('description').notNull().default(''),
  tmuxConfigId: text('tmux_config_id'),
  defaultPermissionProfile: text('default_permission_profile').default('interactive'),
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
  permissionProfile: text('permission_profile').notNull().default('interactive'),
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
  permissionProfile: text('permission_profile').notNull().default('interactive'),
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
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
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

export const pendingMessages = sqliteTable('pending_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  direction: text('direction').notNull(), // 'output' | 'input'
  seqNum: integer('seq_num').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});
