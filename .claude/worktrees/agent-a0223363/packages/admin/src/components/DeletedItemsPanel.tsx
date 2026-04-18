import { Signal, signal } from '@preact/signals';

interface DeletedItem {
  id: string;
  label: string;
  deletedAt: Date;
}

const stores: Record<string, Signal<DeletedItem[]>> = {};

function getStore(type: string): Signal<DeletedItem[]> {
  if (!stores[type]) stores[type] = signal([]);
  return stores[type];
}

export function trackDeletion(type: string, id: string, label: string) {
  const store = getStore(type);
  store.value = [{ id, label, deletedAt: new Date() }, ...store.value];
}

export function purgeAll(type: string) {
  getStore(type).value = [];
}

export function purgeOne(type: string, id: string) {
  const store = getStore(type);
  store.value = store.value.filter(i => i.id !== id);
}

export function DeletedItemsPanel({ type }: { type: string }) {
  const store = getStore(type);
  if (store.value.length === 0) return null;

  return (
    <div class="deleted-items-panel">
      <div class="deleted-items-header">
        <span>Recently Deleted ({store.value.length})</span>
        <button class="btn btn-sm" onClick={() => purgeAll(type)}>Purge All</button>
      </div>
      <div class="deleted-items-list">
        {store.value.map(item => (
          <div class="deleted-item" key={item.id}>
            <span class="deleted-item-label">{item.label}</span>
            <span class="deleted-item-time">{item.deletedAt.toLocaleTimeString()}</span>
            <button class="btn btn-sm" onClick={() => purgeOne(type, item.id)} title="Dismiss">&times;</button>
          </div>
        ))}
      </div>
    </div>
  );
}
