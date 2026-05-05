// Resolves the right xshell install one-liner for the current OS. Used by the
// UpdateDialog and SettingsView so users can copy the command that matches
// their platform. The xshell.sh landing page serves install.ps1 and install.sh.

export type InstallPlatform = "windows" | "unix";

export interface InstallCommand {
  platform: InstallPlatform;
  command: string;
}

export function detectInstallCommand(): InstallCommand {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const isUnix = /Mac|Linux|iPhone|iPad|iPod/i.test(ua) && !/Windows/i.test(ua);
  return {
    platform: isUnix ? "unix" : "windows",
    command: isUnix
      ? "curl -fsSL https://xshell.sh/install.sh | bash"
      : "irm https://xshell.sh/install.ps1 | iex",
  };
}
