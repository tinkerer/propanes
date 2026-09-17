export const COS_WORKSPACE_ID = '__cos__';

export function browsableAppId(appId: string | null): string | null {
  return appId && appId !== COS_WORKSPACE_ID ? appId : null;
}
