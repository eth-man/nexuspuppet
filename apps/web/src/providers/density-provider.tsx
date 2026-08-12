'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * How large the console renders.
 *
 * A ROOT FONT-SIZE MULTIPLIER, not a font-size. Everything on the page is rem,
 * so this moves type, controls and spacing together — density is a whole-layout
 * property, and growing the text alone would leave 32px controls wrapped around
 * 14px labels.
 *
 * It MULTIPLIES the reader's browser font-size setting rather than replacing it
 * (see `html { font-size: calc(100% * var(--ui-scale)) }`). Somebody who has
 * already asked their browser for larger text gets that, and this on top.
 */
export type DensityPreference = 'compact' | 'comfortable' | 'large';

export const DENSITY_STORAGE_KEY = 'nexuspuppet.density';

/**
 * Pre-paint bootstrap, injected as a raw <script> by the root layout.
 *
 * Kept beside the provider that has to agree with it, for the same reason the
 * theme one is: two copies of this rule in different files eventually disagree,
 * and the symptom is the layout jumping size after first paint.
 *
 * try/catch because localStorage throws outright when site data is blocked, and
 * a density preference is not worth a blank page.
 */
export const DENSITY_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    if (stored === 'comfortable' || stored === 'large') {
      document.documentElement.setAttribute('data-density', stored);
    }
  } catch (e) {}
})();
`.trim();

interface DensityContextValue {
  preference: DensityPreference;
  setPreference: (next: DensityPreference) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

/**
 * Absence means COMPACT.
 *
 * Compact is what the console has always looked like and is pixel-identical to
 * before this existed, so an operator who upgrades and expresses no opinion
 * sees exactly what they saw yesterday.
 */
function readPreference(): DensityPreference {
  try {
    const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
    return stored === 'comfortable' || stored === 'large' ? stored : 'compact';
  } catch {
    return 'compact';
  }
}

export function DensityProvider({ children }: { children: ReactNode }) {
  // Starts at the default because this renders on the server too, where there
  // is no storage. The effect corrects it on mount, and the bootstrap script
  // has already applied the right attribute so nothing resizes visibly.
  const [preference, setPreferenceState] = useState<DensityPreference>('compact');

  useEffect(() => {
    setPreferenceState(readPreference());
  }, []);

  useEffect(() => {
    // Compact removes the attribute rather than setting it, so the default
    // state is the ABSENCE of an override — one less thing to keep in step
    // between the bootstrap, the CSS and this provider.
    if (preference === 'compact') {
      document.documentElement.removeAttribute('data-density');
    } else {
      document.documentElement.setAttribute('data-density', preference);
    }
  }, [preference]);

  const setPreference = useCallback((next: DensityPreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // Site data blocked. The choice still applies to this tab; it just will
      // not survive a reload, which beats refusing to change at all.
    }
  }, []);

  return (
    <DensityContext.Provider value={{ preference, setPreference }}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const value = useContext(DensityContext);
  if (value === null) throw new Error('useDensity must be used inside DensityProvider');
  return value;
}
