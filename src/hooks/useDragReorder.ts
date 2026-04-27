import { useEffect, useRef, useState } from "react";

interface Options<T> {
  items: T[];
  direction: "vertical" | "horizontal";
  itemSelector: string; // e.g. '.ds-item[data-idx]'
  onReorder: (newItems: T[]) => void;
}

export function useDragReorder<T>({ items, direction, itemSelector, onReorder }: Options<T>) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const stateRef = useRef<{ startIdx: number; startX: number; startY: number; dragging: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return; // left click only
    stateRef.current = { startIdx: idx, startX: e.clientX, startY: e.clientY, dragging: false };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!s.dragging && dist > 6) {
        s.dragging = true;
        setDragIdx(s.startIdx);
        document.body.style.cursor = "grabbing";
      }
      if (s.dragging) {
        // Find the item under the pointer
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        const item = (el as HTMLElement).closest(itemSelector);
        if (item) {
          const rect = item.getBoundingClientRect();
          const idx = parseInt(item.getAttribute("data-idx") || "-1", 10);
          if (idx >= 0) {
            // Determine insert position: before or after target based on pointer position
            const mid = direction === "vertical" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
            const p = direction === "vertical" ? e.clientY : e.clientX;
            setOverIdx(p < mid ? idx : idx + 1);
          }
        } else {
          // Pointer is outside the list — clear so releasing there doesn't trigger a stale reorder.
          setOverIdx(null);
        }
      }
    };

    const onUp = () => {
      const s = stateRef.current;
      if (s?.dragging && dragIdx !== null && overIdx !== null) {
        let target = overIdx;
        if (target > dragIdx) target -= 1; // account for removal
        if (target !== dragIdx) {
          const newItems = [...items];
          const [moved] = newItems.splice(dragIdx, 1);
          newItems.splice(target, 0, moved);
          onReorder(newItems);
        }
      }
      stateRef.current = null;
      document.body.style.cursor = "";
      setDragIdx(null);
      setOverIdx(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [items, dragIdx, overIdx, onReorder, itemSelector, direction]);

  return { dragIdx, overIdx, onPointerDown };
}
