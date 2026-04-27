import type { SessionInfo } from "./types";

export function timeAgo(isoDate: string): string {
  if (!isoDate) return "";
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diff = now - then;
  if (isNaN(diff) || diff < 0) return "";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function isUnnamed(title: string): boolean {
  return /^Session [a-f0-9]{8}$/i.test(title) || title.trim() === "";
}

/** Sort named sessions first (by time), then unnamed (by time). Rename unnamed to "Unnamed #N". */
export function processSessions(sessions: SessionInfo[]): SessionInfo[] {
  const named = sessions.filter(s => !isUnnamed(s.title));
  const unnamed = sessions.filter(s => isUnnamed(s.title));

  named.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  unnamed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const result: SessionInfo[] = [
    ...named,
    ...unnamed.map((s, i) => ({ ...s, title: `Unnamed #${i + 1}` })),
  ];
  return result;
}
