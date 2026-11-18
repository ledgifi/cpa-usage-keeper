import { useState, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let now: number | null = null;
let interval: number | undefined;

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    now = Date.now();
    interval = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(interval);
      now = null;
    }
  };
}

const getSnapshot = () => now;
const getIdleSnapshot = () => null;
const subscribeIdle = () => () => {};

// Scope rerenders to quota displays. An absent offset leaves the display clock idle.
export function useQuotaClock(clockOffset?: number) {
  const [mountedAt] = useState(Date.now);
  const active = clockOffset !== undefined;
  const time = useSyncExternalStore(active ? subscribe : subscribeIdle, active ? getSnapshot : getIdleSnapshot, getIdleSnapshot);
  return (time ?? mountedAt) + (clockOffset ?? 0);
}
