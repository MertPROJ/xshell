import { useCallback } from "react";
import { X } from "lucide-react";
import type { LayoutNode } from "../types";
import { useTooltip, ttProps } from "./Tooltip";

interface Props {
  layout: LayoutNode;
  activeLeafId: string | null;
  onFocusLeaf: (tabId: string) => void;
  onClosePane: (tabId: string) => void;
  onRatioChange: (path: number[], ratio: number) => void;
}

// Renders a binary layout tree as nested flex containers. Leaves render an empty slot
// (the TerminalTab's DOM gets physically moved into that slot at the App level), so the
// terminal is never unmounted when the layout rearranges.
export function GroupView({ layout, activeLeafId, onFocusLeaf, onClosePane, onRatioChange }: Props) {
  const { tt, Tooltip } = useTooltip();
  return <>
    <LayoutRenderer node={layout} path={[]} activeLeafId={activeLeafId} onFocusLeaf={onFocusLeaf} onClosePane={onClosePane} onRatioChange={onRatioChange} tt={tt} />
    {Tooltip}
  </>;
}

interface NodeProps {
  node: LayoutNode;
  path: number[];
  activeLeafId: string | null;
  onFocusLeaf: (tabId: string) => void;
  onClosePane: (tabId: string) => void;
  onRatioChange: (path: number[], ratio: number) => void;
  tt: ReturnType<typeof useTooltip>["tt"];
}

function LayoutRenderer({ node, path, activeLeafId, onFocusLeaf, onClosePane, onRatioChange, tt }: NodeProps) {
  if (node.kind === "leaf") {
    const isActive = activeLeafId === node.tabId;
    return (
      <div className={`group-pane ${isActive ? "group-pane-active" : ""}`} data-group-leaf={node.tabId} onPointerDownCapture={() => onFocusLeaf(node.tabId)} onFocusCapture={() => onFocusLeaf(node.tabId)}>
        <div className="terminal-slot" data-terminal-slot={node.tabId} />
        <button className="group-pane-close" onClick={() => onClosePane(node.tabId)} {...ttProps(tt, "Close pane")} onPointerDown={(e) => e.stopPropagation()}>
          <X size={11} />
        </button>
      </div>
    );
  }
  const dir = node.direction;
  return (
    <div className={`group-split group-split-${dir}`}>
      <div className="group-split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <LayoutRenderer node={node.children[0]} path={[...path, 0]} activeLeafId={activeLeafId} onFocusLeaf={onFocusLeaf} onClosePane={onClosePane} onRatioChange={onRatioChange} tt={tt} />
      </div>
      <Splitter direction={dir} path={path} onRatioChange={onRatioChange} />
      <div className="group-split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <LayoutRenderer node={node.children[1]} path={[...path, 1]} activeLeafId={activeLeafId} onFocusLeaf={onFocusLeaf} onClosePane={onClosePane} onRatioChange={onRatioChange} tt={tt} />
      </div>
    </div>
  );
}

function Splitter({ direction, path, onRatioChange }: { direction: "col" | "row"; path: number[]; onRatioChange: (path: number[], ratio: number) => void }) {
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const splitEl = e.currentTarget.parentElement;
    if (!splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const r = direction === "col"
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      onRatioChange(path, Math.max(0.15, Math.min(0.85, r)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = direction === "col" ? "col-resize" : "row-resize";
  }, [direction, path, onRatioChange]);
  return <div className={`group-splitter group-splitter-${direction}`} onPointerDown={onDown} />;
}
