import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "MertPROJ/xshell";

export interface ReleaseEntry {
  version: string;
  url: string;
  notes: string;
  publishedAt: string | null;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  releases: ReleaseEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Compare two semver-ish strings ("1.2.3", "v1.2.3", "1.2.3-beta.1"). Returns >0 if a > b.
// Strips a leading "v" and any pre-release / build suffix — we only care about the numeric core
// for "is the GitHub release newer than what's installed".
function cmpSemver(a: string, b: string): number {
  const norm = (s: string) => s.replace(/^v/i, "").split(/[-+]/)[0];
  const pa = norm(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = norm(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// Checks GitHub Releases for newer versions of xshell. Hits /releases?per_page=20, filters out
// drafts + prereleases, and exposes both the latest entry (drives the red badge on the settings
// cog) and the full list (powers the changelog in Settings → About). Cached for the session —
// re-fetch via `refresh()`.
export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState("");
  const [releases, setReleases] = useState<ReleaseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const cv = await getVersion();
        if (cancelled) return;
        setCurrentVersion(cv);
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
        const data = await res.json() as Array<{ tag_name?: string; html_url?: string; body?: string; published_at?: string; draft?: boolean; prerelease?: boolean }>;
        if (cancelled) return;
        const list: ReleaseEntry[] = data
          .filter(r => !r.draft && !r.prerelease && r.tag_name)
          .map(r => ({
            version: (r.tag_name || "").replace(/^v/i, ""),
            url: r.html_url || "",
            notes: r.body || "",
            publishedAt: r.published_at || null,
          }));
        setReleases(list);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);
  const latest = releases[0] || null;
  const latestVersion = latest?.version ?? null;
  const releaseUrl = latest?.url ?? null;
  const releaseNotes = latest?.notes ?? null;
  const publishedAt = latest?.publishedAt ?? null;
  const updateAvailable = !!latestVersion && !!currentVersion && cmpSemver(latestVersion, currentVersion) > 0;
  return { currentVersion, latestVersion, updateAvailable, releaseUrl, releaseNotes, publishedAt, releases, loading, error, refresh };
}
