import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, ReactNode } from "react";

export type TtFns = { showTt: (text: string, el: HTMLElement) => void; hideTt: () => void };

function TooltipView({ text, rect }: { text: string; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ top: rect.bottom + 6, left: -9999 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const w = ref.current.offsetWidth;
    const half = w / 2;
    const preferred = rect.left + rect.width / 2;
    const left = Math.max(half + 4, Math.min(preferred, window.innerWidth - half - 4));
    setStyle({ top: rect.bottom + 6, left });
  }, [rect, text]);
  return <div className="tab-tooltip" ref={ref} style={style}>{text}</div>;
}

// Lightweight tooltip primitive — usable anywhere without threading state through props.
// Returns the `tt` helpers plus the <Tooltip /> element you render once near the root.
export function useTooltip() {
  const [tooltip, setTooltip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const showTt = useCallback((text: string, el: HTMLElement) => setTooltip({ text, rect: el.getBoundingClientRect() }), []);
  const hideTt = useCallback(() => setTooltip(null), []);
  const tt: TtFns = useMemo(() => ({ showTt, hideTt }), [showTt, hideTt]);
  const Tooltip = tooltip ? <TooltipView text={tooltip.text} rect={tooltip.rect} /> : null;
  return { tt, Tooltip };
}

// Context so deeply-nested components can trigger tooltips without prop drilling.
const TtContext = createContext<TtFns | null>(null);
export function TooltipProvider({ tt, children }: { tt: TtFns; children: ReactNode }) {
  return <TtContext.Provider value={tt}>{children}</TtContext.Provider>;
}
export function useTt(): TtFns | null { return useContext(TtContext); }

// Convenience props for any element that wants a custom tooltip on hover.
// Usage: <button {...ttProps(tt, "Reveal in Explorer")}>...</button>
export function ttProps(tt: TtFns | null, text: string) {
  if (!tt) return {};
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => tt.showTt(text, e.currentTarget),
    onMouseLeave: () => tt.hideTt(),
  };
}
