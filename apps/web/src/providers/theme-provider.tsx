'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** What an operator can choose. `system` follows the OS and keeps following it. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** What is actually on screen once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'nexuspuppet.theme';

/**
 * The pre-paint bootstrap, injected as a raw <script> by the root layout.
 *
 * Kept as a string next to the provider that has to agree with it. The two
 * pieces read the same key and apply the same rule, and a copy of this logic
 * living in a different file is a copy that eventually disagrees — which shows
 * up as a flash of the wrong theme, the one bug this exists to prevent.
 *
 * Wrapped in try/catch because localStorage throws outright in a browser with
 * site data blocked, and a theme preference is not worth a blank page.
 */
export const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`.trim();

interface ThemeContextValue {
  /** What the operator asked for, including `system`. */
  preference: ThemePreference;
  /** What that resolves to right now. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Holds the theme preference and keeps `data-theme` in step with it.
 *
 * The attribute is the single source of truth for the CSS; this provider exists
 * so a control can render the current choice and change it, not so components
 * can ask what theme they are in. A component that branches on the theme has
 * hardcoded a colour somewhere it should have used a token.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  /*
   * Starts as 'dark' rather than reading storage, because this runs on the
   * server too and there is no storage there. The effect below corrects it on
   * mount; the bootstrap script has already put the right value on <html>, so
   * nothing flashes while that happens.
   */
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    const stored = readPreference();
    setPreferenceState(stored);
    setResolved(stored === 'system' ? systemTheme() : stored);
  }, []);

  /*
   * Following the OS means following it after the choice, not at the moment of
   * it. Somebody whose machine switches at sunset expects the console to switch
   * with it, without reloading the page.
   */
  useEffect(() => {
    if (preference !== 'system') return;

    const query = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => setResolved(query.matches ? 'light' : 'dark');
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [preference]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setResolved(next === 'system' ? systemTheme() : next);

    try {
      // 'system' is the ABSENCE of a preference, not a third stored value — so
      // a machine that later changes its OS default is followed rather than
      // pinned to whatever it happened to be on the day somebody chose this.
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Site data blocked. The choice still applies to this tab; it just will
      // not survive a reload, which is better than refusing to change at all.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
