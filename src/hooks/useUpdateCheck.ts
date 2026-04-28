import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "MertPROJ/xshell";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
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

// Checks GitHub Releases for a newer version of xshell. Hits /releases/latest (which already
// excludes drafts + prereleases), normalizes the tag, and exposes everything the UI needs:
// the version comparison drives the red badge on the settings cog, and the rest populates the
// About page in Settings. Cached for the session — re-fetch via `refresh()`.
export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState("");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
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
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
        const data = await res.json() as { tag_name?: string; html_url?: string; body?: string; published_at?: string };
        if (cancelled) return;
        setLatestVersion((data.tag_name || "").replace(/^v/i, "") || null);
        setReleaseUrl(data.html_url || null);
        setReleaseNotes(data.body || null);
        setPublishedAt(data.published_at || null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);
  const updateAvailable = !!latestVersion && !!currentVersion && cmpSemver(latestVersion, currentVersion) > 0;
  return { currentVersion, latestVersion, updateAvailable, releaseUrl, releaseNotes, publishedAt, loading, error, refresh };
}
