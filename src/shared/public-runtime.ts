export const CONTROL_GITHUB_LIVE_READS_FLAG = "CONTROL_GITHUB_LIVE_READS";
export const CONTROL_GITHUB_LIVE_READS_ENABLED = "enabled";
export const CONTROL_GITHUB_LIVE_READS_DISABLED = "disabled";

export function isGitHubLiveReadModeEnabled(value: string | undefined): boolean {
  return value === CONTROL_GITHUB_LIVE_READS_ENABLED;
}
