export function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString();
}
