'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthenticatedPrincipal, Permission } from '@nexuspuppet/contracts';
import { ApiError, api } from '@/lib/client';

/**
 * Session state for the browser.
 *
 * The principal comes from GET /auth/me, not from decoding a token: the session
 * cookie is HttpOnly and unreadable by design, which is what stops an XSS from
 * exfiltrating it (ADR-0006).
 *
 * `can()` drives what the UI OFFERS. It is a usability affordance and never a
 * security control — the API re-checks every permission independently, so a
 * hidden button and a blocked request are separate mechanisms (C4 L2).
 */

interface Session {
  principal: AuthenticatedPrincipal;
  permissions: Permission[];
}

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  principal: AuthenticatedPrincipal | null;
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  const load = useCallback(async () => {
    try {
      const me = await api.get<Session>('/auth/me');
      setSession(me);
      setStatus('authenticated');
    } catch (error) {
      // A 401 here is the ordinary "not logged in" case, not a failure.
      if (error instanceof ApiError && error.isUnauthenticated) {
        setSession(null);
        setStatus('anonymous');
        return;
      }
      // Anything else — API unreachable, for instance — must not masquerade as
      // being logged out, or the user gets a login form for a problem a
      // password will not fix.
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<Session>('/auth/login', { email, password });
    setSession(result);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Clear locally even if the call failed: the user asked to leave.
      setSession(null);
      setStatus('anonymous');
      router.push('/login');
    }
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      principal: session?.principal ?? null,
      permissions: session?.permissions ?? [],
      can: (permission) => session?.permissions.includes(permission) ?? false,
      login,
      logout,
      refresh: load,
    }),
    [status, session, login, logout, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
