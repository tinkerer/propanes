import { Hono } from 'hono';
import { feedbackRoutes } from './feedback.js';
import { agentRoutes } from './agents.js';
import { systemRoutes } from './system.js';

export const adminRoutes = new Hono();

adminRoutes.route('/', feedbackRoutes);
adminRoutes.route('/', agentRoutes);
adminRoutes.route('/', systemRoutes);
