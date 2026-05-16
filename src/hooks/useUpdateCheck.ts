import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";

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
  update: Update | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Source of truth is Tauri's updater plugin (`check()`) — it returns a signed Update or null,
// and the same Update object is what `useInstaller` calls `downloadAndInstall()` on. We *also*
// fetch the GitHub Releases list, but only to populate the multi-release changelog in
// Settings → About. That secondary call is best-effort: a failure there doesn't block the
// badge or the install button.
export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
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
        const u = await check();
        if (cancelled) return;
        setUpdate(u);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) return;
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
      } catch { /* changelog is optional — offline / API rate limited is fine */ }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);
  const latestVersion = update?.version ?? null;
  const releaseUrl = latestVersion ? `https://github.com/${REPO}/releases/tag/v${latestVersion}` : null;
  const fromChangelog = latestVersion ? releases.find(r => r.version === latestVersion) : undefined;
  const releaseNotes = update?.body ?? fromChangelog?.notes ?? null;
  const publishedAt = update?.date ?? fromChangelog?.publishedAt ?? null;
  const updateAvailable = update !== null;
  return { currentVersion, latestVersion, updateAvailable, releaseUrl, releaseNotes, publishedAt, releases, update, loading, error, refresh };
}
