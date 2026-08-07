"use client";

import { useSyncExternalStore, useEffect, useState } from "react";

interface Toast {
  id: number;
  message: string;
}

let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

export function toast(message: string) {
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  emitChange();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitChange();
  }, 2500);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toasts;
}

export function Toaster() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <ToastItem key={t.id} message={t.message} />
      ))}
    </div>
  );
}

function ToastItem({ message }: { message: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`bg-card border border-border text-foreground text-sm px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {message}
    </div>
  );
}
