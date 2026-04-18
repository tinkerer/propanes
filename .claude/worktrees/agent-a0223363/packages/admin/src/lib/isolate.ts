import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';

const params = new URLSearchParams(window.location.search);

export const isolatedComponent = signal<string | null>(params.get('isolate'));

export interface IsolateEntry {
  label: string;
  render: ((params: URLSearchParams) => ComponentChildren) | null;
}

const registry = new Map<string, IsolateEntry>();

// Widget: render null = blank page, widget script auto-initializes
registry.set('widget', { label: 'Widget', render: null });

export function getIsolateEntry(name: string): IsolateEntry | undefined {
  return registry.get(name);
}

export function getIsolateNames(): string[] {
  return Array.from(registry.keys());
}

export function getIsolateParams(): URLSearchParams {
  return params;
}
