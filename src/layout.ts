import type { LayoutNode } from "./types";

export function countLeaves(n: LayoutNode): number {
  return n.kind === "leaf" ? 1 : countLeaves(n.children[0]) + countLeaves(n.children[1]);
}

export function collectLeafIds(n: LayoutNode): string[] {
  if (n.kind === "leaf") return [n.tabId];
  return [...collectLeafIds(n.children[0]), ...collectLeafIds(n.children[1])];
}

export function hasLeaf(n: LayoutNode, tabId: string): boolean {
  if (n.kind === "leaf") return n.tabId === tabId;
  return hasLeaf(n.children[0], tabId) || hasLeaf(n.children[1], tabId);
}

export type DropZone = "left" | "right" | "top" | "bottom";

// Insert a new leaf adjacent to the target leaf. Creates a split node in its place.
// zone determines which side the new leaf ends up on relative to the target.
export function insertLeaf(root: LayoutNode, targetTabId: string, newTabId: string, zone: DropZone): LayoutNode {
  if (root.kind === "leaf") {
    if (root.tabId !== targetTabId) return root;
    const direction: "col" | "row" = zone === "left" || zone === "right" ? "col" : "row";
    const newLeaf: LayoutNode = { kind: "leaf", tabId: newTabId };
    const children: [LayoutNode, LayoutNode] = zone === "left" || zone === "top"
      ? [newLeaf, root]
      : [root, newLeaf];
    return { kind: "split", direction, children, ratio: 0.5 };
  }
  return {
    ...root,
    children: [
      insertLeaf(root.children[0], targetTabId, newTabId, zone),
      insertLeaf(root.children[1], targetTabId, newTabId, zone),
    ],
  };
}

// Set the ratio on the split node at the given path (0 = left child, 1 = right child sequence).
// Returns the updated tree; if the path doesn't land on a split, the input is returned unchanged.
export function setRatioAt(root: LayoutNode, path: number[], ratio: number): LayoutNode {
  if (path.length === 0) {
    if (root.kind !== "split") return root;
    return { ...root, ratio };
  }
  if (root.kind !== "split") return root;
  const [head, ...rest] = path;
  if (head === 0) return { ...root, children: [setRatioAt(root.children[0], rest, ratio), root.children[1]] };
  if (head === 1) return { ...root, children: [root.children[0], setRatioAt(root.children[1], rest, ratio)] };
  return root;
}

// Remove a leaf; if its parent split is left with just one child, that child replaces the split.
// Returns null if removing the leaf would empty the tree entirely.
export function removeLeaf(root: LayoutNode, tabId: string): LayoutNode | null {
  if (root.kind === "leaf") return root.tabId === tabId ? null : root;
  const a = removeLeaf(root.children[0], tabId);
  const b = removeLeaf(root.children[1], tabId);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return { ...root, children: [a, b] };
}
