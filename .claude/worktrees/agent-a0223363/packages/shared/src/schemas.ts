import { z } from 'zod';
import { FEEDBACK_TYPES, FEEDBACK_STATUSES, DISPATCH_MODES, PERMISSION_PROFILES } from './constants.js';

export const feedbackSubmitSchema = z.object({
  type: z.enum(FEEDBACK_TYPES).default('manual'),
  title: z.string().max(500).default(''),
  description: z.string().max(10000).default(''),
  data: z.record(z.unknown()).optional(),
  context: z
    .object({
      consoleLogs: z
        .array(
          z.object({
            level: z.enum(['log', 'warn', 'error', 'info', 'debug']),
            message: z.string(),
            timestamp: z.number(),
          })
        )
        .optional(),
      networkErrors: z
        .array(
          z.object({
            url: z.string(),
            method: z.string(),
            status: z.number(),
            statusText: z.string(),
            timestamp: z.number(),
          })
        )
        .optional(),
      performanceTiming: z
        .object({
          loadTime: z.number().optional(),
          domContentLoaded: z.number().optional(),
          firstContentfulPaint: z.number().optional(),
          largestContentfulPaint: z.number().optional(),
        })
        .optional(),
      environment: z
        .object({
          userAgent: z.string(),
          language: z.string(),
          platform: z.string(),
          screenResolution: z.string(),
          viewport: z.string(),
          url: z.string(),
          referrer: z.string(),
          timestamp: z.number(),
        })
        .optional(),
    })
    .optional(),
  sourceUrl: z.string().url().optional(),
  userAgent: z.string().optional(),
  viewport: z.string().optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  autoDispatch: z.boolean().optional(),
  appId: z.string().optional(),
  launcherId: z.string().optional(),
});

export type FeedbackSubmitInput = z.infer<typeof feedbackSubmitSchema>;

export const feedbackUpdateSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  data: z.record(z.unknown()).optional(),
  context: z
    .object({
      consoleLogs: z
        .array(
          z.object({
            level: z.enum(['log', 'warn', 'error', 'info', 'debug']),
            message: z.string(),
            timestamp: z.number(),
          })
        )
        .optional(),
      networkErrors: z
        .array(
          z.object({
            url: z.string(),
            method: z.string(),
            status: z.number(),
            statusText: z.string(),
            timestamp: z.number(),
          })
        )
        .optional(),
      performanceTiming: z
        .object({
          loadTime: z.number().optional(),
          domContentLoaded: z.number().optional(),
          firstContentfulPaint: z.number().optional(),
          largestContentfulPaint: z.number().optional(),
        })
        .optional(),
      environment: z
        .object({
          userAgent: z.string(),
          language: z.string(),
          platform: z.string(),
          screenResolution: z.string(),
          viewport: z.string(),
          url: z.string(),
          referrer: z.string(),
          timestamp: z.number(),
        })
        .optional(),
    })
    .optional(),
});

export const adminFeedbackCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  type: z.enum(FEEDBACK_TYPES).default('manual'),
  appId: z.string(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export type FeedbackUpdateInput = z.infer<typeof feedbackUpdateSchema>;

export const feedbackListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  type: z.enum(FEEDBACK_TYPES).optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  appId: z.string().optional(),
  dispatchStatus: z.string().optional(),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const batchOperationSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  operation: z.enum(['updateStatus', 'addTag', 'removeTag', 'delete', 'permanentDelete']),
  value: z.string().optional(),
});

export const controlActionSchema = z.object({
  id: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  command: z.string().min(1).max(1000),
  icon: z.string().max(10).optional(),
});

export const requestPanelSuggestionSchema = z.object({
  label: z.string().min(1).max(200),
  prompt: z.string().min(1).max(2000),
});

export const requestPanelPreferenceSchema = z.object({
  id: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  promptSnippet: z.string().min(1).max(500),
  default: z.boolean().optional(),
});

export const requestPanelConfigSchema = z.object({
  suggestions: z.array(requestPanelSuggestionSchema).max(20).default([]),
  preferences: z.array(requestPanelPreferenceSchema).max(10).default([]),
  defaultAgentId: z.string().optional(),
  promptPrefix: z.string().max(5000).optional(),
});

export const applicationSchema = z.object({
  name: z.string().min(1).max(100),
  projectDir: z.string().min(1).max(500),
  serverUrl: z.string().url().optional(),
  hooks: z.array(z.string().max(100)).max(50).default([]),
  description: z.string().max(5000).default(''),
  tmuxConfigId: z.string().nullable().optional(),
  defaultPermissionProfile: z.string().max(100).optional(),
  defaultAllowedTools: z.string().max(5000).nullable().optional(),
  agentPath: z.string().max(500).nullable().optional(),
  screenshotIncludeWidget: z.boolean().optional(),
  autoDispatch: z.boolean().optional(),
  controlActions: z.array(controlActionSchema).max(20).default([]),
  requestPanel: requestPanelConfigSchema.default({ suggestions: [], preferences: [] }),
});

export const applicationUpdateSchema = applicationSchema.partial();

export const agentEndpointSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().default(''),
  authHeader: z.string().optional(),
  isDefault: z.boolean().default(false),
  appId: z.string().optional(),
  promptTemplate: z.string().max(10000).optional(),
  mode: z.enum(DISPATCH_MODES).default('webhook'),
  permissionProfile: z.enum(PERMISSION_PROFILES).default('interactive'),
  allowedTools: z.string().max(5000).optional(),
  autoPlan: z.boolean().default(false),
  preferredLauncherId: z.string().nullable().optional(),
  harnessConfigId: z.string().nullable().optional(),
  spriteConfigId: z.string().nullable().optional(),
});

export const dispatchSchema = z.object({
  feedbackId: z.string(),
  agentEndpointId: z.string(),
  instructions: z.string().max(5000).optional(),
  launcherId: z.string().optional(),
  harnessConfigId: z.string().optional(),
});

export const PLAN_STATUSES = ['draft', 'active', 'completed'] as const;

export const aggregateQuerySchema = z.object({
  appId: z.string().optional(),
  type: z.enum(FEEDBACK_TYPES).optional(),
  status: z.enum(FEEDBACK_STATUSES).optional(),
  includeClosed: z.coerce.boolean().default(false),
  minCount: z.coerce.number().int().min(1).default(1),
});

export const planCreateSchema = z.object({
  groupKey: z.string().min(1),
  title: z.string().min(1).max(500),
  body: z.string().max(50000).default(''),
  status: z.enum(PLAN_STATUSES).default('draft'),
  linkedFeedbackIds: z.array(z.string()).default([]),
  appId: z.string().optional(),
});

export const planUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(50000).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  linkedFeedbackIds: z.array(z.string()).optional(),
});

export const analyzeSchema = z.object({
  appId: z.string(),
  agentEndpointId: z.string(),
});

export const agentBatchRequestSchema = z.object({
  commands: z.array(z.object({
    command: z.string().min(1),
    params: z.record(z.unknown()).default({}),
  })).min(1).max(50),
  stopOnError: z.boolean().default(true),
  commandTimeout: z.number().int().min(1000).max(30000).default(15000),
});

export type AgentBatchRequest = z.infer<typeof agentBatchRequestSchema>;

export const sessionAliasSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
});

export const analyzeClusterSchema = z.object({
  appId: z.string(),
  agentEndpointId: z.string(),
  feedbackIds: z.array(z.string()).min(1),
  clusterTitle: z.string(),
});

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
