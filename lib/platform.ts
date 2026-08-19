/**
 * Platform detection helpers for client-only code paths.
 *
 * All helpers are SSR-safe: they fall back to a sensible default
 * (non-mac, non-touch, etc.) when `window` or `navigator` is undefined,
 * which is the right default for the server side of a Next.js render.
 *
 * Callers should generally use these inside a `useEffect` or a "use client"
 * component so the value can be re-evaluated in the browser.
 */

export function isMacOs(): boolean {
  if (typeof navigator === "undefined") return false;
  // userAgentData is the modern, structured alternative; userAgent is the
  // universal fallback. We also normalize against common Chromium quirks
  // (e.g. iPad reporting as Mac on Safari desktop UA).
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  const ua = navigator.userAgent ?? "";
  if (/Mac/i.test(platform)) return true;
  if (/Mac/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua)) return true;
  return false;
}

export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 1;
}
