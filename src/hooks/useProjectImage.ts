import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, string>();

export function useProjectImage(iconValue: string | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    if (!iconValue?.startsWith("img:")) return null;
    return cache.get(iconValue) || null;
  });

  useEffect(() => {
    if (!iconValue?.startsWith("img:")) { setDataUrl(null); return; }
    if (cache.has(iconValue)) { setDataUrl(cache.get(iconValue)!); return; }
    let cancelled = false;
    invoke<string>("read_image_base64", { path: iconValue.slice(4) }).then(url => {
      if (!cancelled) { cache.set(iconValue, url); setDataUrl(url); }
    }).catch(() => { if (!cancelled) setDataUrl(null); });
    return () => { cancelled = true; };
  }, [iconValue]);

  return dataUrl;
}
