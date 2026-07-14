// Tiny module-level toast store. The emitter (useEventStream, mounted above
// the router) and the viewport (inside AppShell) live in different React
// subtrees, so this bridges them without a context provider — same
// module-state-plus-hook shape as useDarkMode.
import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  kind: "success" | "warning" | "error";
  title: string;
  message?: string;
}

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 6000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function pushToast(t: Omit<Toast, "id">) {
  const toast: Toast = { ...t, id: nextId++ };
  toasts = [...toasts, toast].slice(-MAX_TOASTS);
  notify();
  setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
}

export function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getToasts() {
  return toasts;
}

/** Live toast list for the viewport component. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getToasts);
}
