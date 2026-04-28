// Wiggum learnings + announcement state.
//
// The Chief-of-Staff exposes a "learnings" sidebar fed by Wiggum (an
// embedded reflection agent that scans recent CoS sessions). This module
// owns the client-side cache + REST helpers; the LearningsDrawer component
// reads from these signals and dispatches the actions.

import { signal } from '@preact/signals';
import { adminHeaders } from './admin-headers.js';

export type CosLearning = {
  id: string;
  sessionJsonl: string | null;
  type: 'pitfall' | 'suggestion' | 'tool_gap';
  title: string;
  body: string;
  severity: 'low' | 'medium' | 'high';
  tags: string[];
  createdAt: number;
};

export type CosLearningRelType = 'related' | 'caused_by' | 'resolved_by' | 'duplicate_of';
export type CosLearningLinkSource = 'user' | 'wiggum' | 'auto';

export type CosLearningEdge = {
  id: string;
  fromId: string;
  toId: string;
  relType: CosLearningRelType;
  source: CosLearningLinkSource;
  createdAt: number;
};

export type CosLearningLinkPeer = {
  linkId: string;
  relType: CosLearningRelType;
  source: CosLearningLinkSource;
  createdAt: number;
  peer: { id: string; title: string; type: CosLearning['type']; severity: CosLearning['severity'] } | null;
};

export type CosLearningDetail = {
  learning: CosLearning;
  outgoing: CosLearningLinkPeer[];
  backlinks: CosLearningLinkPeer[];
};

export type CosLearningGraph = {
  nodes: CosLearning[];
  edges: CosLearningEdge[];
};

export type CosLearningSuggestion = {
  peer: { id: string; title: string; type: CosLearning['type']; severity: CosLearning['severity'] };
  similarity: number;
};

export const cosLearnings = signal<CosLearning[]>([]);
export const cosLearningsLoading = signal(false);
export const cosLearningGraph = signal<CosLearningGraph | null>(null);
export const cosLearningGraphLoading = signal(false);

export type WiggumAnnouncement = { summary: string; threadId: string | null; at: number };
export const wiggumAnnouncement = signal<WiggumAnnouncement | null>(null);

export async function loadWiggumAnnouncement(): Promise<void> {
  try {
    const res = await fetch('/api/v1/admin/cos/learnings/announcement', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    wiggumAnnouncement.value = data?.announcement || null;
  } catch {
    /* non-fatal */
  }
}

export async function loadCosLearnings(): Promise<void> {
  cosLearningsLoading.value = true;
  try {
    const res = await fetch('/api/v1/admin/cos/learnings', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.learnings)) {
      cosLearnings.value = data.learnings as CosLearning[];
    }
    // Pull the latest announcement banner alongside learnings.
    void loadWiggumAnnouncement();
  } catch {
    /* non-fatal */
  } finally {
    cosLearningsLoading.value = false;
  }
}

export async function deleteCosLearning(id: string): Promise<void> {
  try {
    await fetch(`/api/v1/admin/cos/learnings/${id}`, { method: 'DELETE', headers: adminHeaders() });
    cosLearnings.value = cosLearnings.value.filter((l) => l.id !== id);
    // Drop the deleted node + any incident edges from the cached graph.
    const g = cosLearningGraph.value;
    if (g) {
      cosLearningGraph.value = {
        nodes: g.nodes.filter((n) => n.id !== id),
        edges: g.edges.filter((e) => e.fromId !== id && e.toId !== id),
      };
    }
  } catch { /* non-fatal */ }
}

export async function loadCosLearningGraph(): Promise<void> {
  cosLearningGraphLoading.value = true;
  try {
    const res = await fetch('/api/v1/admin/cos/learnings/graph', { headers: adminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.nodes) && Array.isArray(data?.edges)) {
      cosLearningGraph.value = data as CosLearningGraph;
    }
  } catch { /* non-fatal */ } finally {
    cosLearningGraphLoading.value = false;
  }
}

export async function fetchCosLearningDetail(id: string): Promise<CosLearningDetail | null> {
  try {
    const res = await fetch(`/api/v1/admin/cos/learnings/${id}`, { headers: adminHeaders() });
    if (!res.ok) return null;
    return await res.json() as CosLearningDetail;
  } catch {
    return null;
  }
}

export async function fetchCosLearningSuggestions(id: string): Promise<CosLearningSuggestion[]> {
  try {
    const res = await fetch(`/api/v1/admin/cos/learnings/${id}/suggested-links`, { headers: adminHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.suggestions) ? data.suggestions as CosLearningSuggestion[] : [];
  } catch {
    return [];
  }
}

export async function createCosLearningLink(
  fromId: string,
  toId: string,
  relType: CosLearningRelType,
): Promise<CosLearningEdge | null> {
  try {
    const res = await fetch(`/api/v1/admin/cos/learnings/${fromId}/links`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ toId, relType, source: 'user' }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const link = data?.link;
    if (!link) return null;
    const edge: CosLearningEdge = {
      id: link.id,
      fromId: link.fromId,
      toId: link.toId,
      relType: link.relType,
      source: link.source,
      createdAt: Date.now(),
    };
    const g = cosLearningGraph.value;
    if (g) cosLearningGraph.value = { nodes: g.nodes, edges: [...g.edges, edge] };
    return edge;
  } catch {
    return null;
  }
}

export async function deleteCosLearningLink(linkId: string): Promise<void> {
  try {
    await fetch(`/api/v1/admin/cos/learnings/links/${linkId}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    const g = cosLearningGraph.value;
    if (g) cosLearningGraph.value = { nodes: g.nodes, edges: g.edges.filter((e) => e.id !== linkId) };
  } catch { /* non-fatal */ }
}

export async function updateCosLearning(
  id: string,
  patch: { title?: string; body?: string; severity?: CosLearning['severity']; tags?: string[] },
): Promise<CosLearning | null> {
  try {
    const res = await fetch(`/api/v1/admin/cos/learnings/${id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const updated = data?.learning as CosLearning | null;
    if (!updated) return null;
    cosLearnings.value = cosLearnings.value.map((l) => (l.id === id ? updated : l));
    const g = cosLearningGraph.value;
    if (g) cosLearningGraph.value = { nodes: g.nodes.map((n) => (n.id === id ? updated : n)), edges: g.edges };
    return updated;
  } catch {
    return null;
  }
}
