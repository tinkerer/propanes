import { selectedAppId } from '../lib/state.js';
import { SidebarFilesDrawer } from './SidebarFilesDrawer.js';

export function FilesView() {
  const appId = selectedAppId.value;
  if (!appId) {
    return (
      <div style={{ padding: '12px', color: 'var(--pw-text-muted)', fontSize: '12px' }}>
        Select an app to browse files
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      <SidebarFilesDrawer appId={appId} open={true} onToggle={() => {}} />
    </div>
  );
}
