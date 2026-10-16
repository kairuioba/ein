import { msg, t } from "../shared/i18n.ts";

export const CLOUD_BACKEND_CHANGE_ERROR = msg("stop the active turn before changing the cloud backend");
export const VPS_ALIAS_CHANGE_ERROR = msg("stop the active VPS turn before changing the SSH config alias");

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? t(CLOUD_BACKEND_CHANGE_ERROR) : null;
}

export function vpsAliasChangeError(currentAlias: string | null, nextAlias: string | null, activeVpsThread: boolean): string | null {
  return activeVpsThread && currentAlias !== nextAlias ? t(VPS_ALIAS_CHANGE_ERROR) : null;
}
