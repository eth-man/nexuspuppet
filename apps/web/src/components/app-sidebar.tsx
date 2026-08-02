'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Boxes,
  ChevronLeft,
  FileText,
  LayoutDashboard,
  LogOut,
  Server,
  Settings,
  Layers,
} from 'lucide-react';
import type { Permission } from '@nexuspuppet/contracts';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/auth-provider';

/**
 * Primary navigation.
 *
 * Collapsible to an icon rail, because the inventory table is the widest thing
 * in the product and an operator comparing columns wants the horizontal space
 * back. The choice persists — re-collapsing on every navigation would be a
 * small, constant irritation.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof Server;
  /**
   * Hidden when the user lacks it. A UI affordance; the API still enforces.
   *
   * Optional: a destination whose landing page needs no permission is shown to
   * everyone, and gates its own sections from there.
   */
  permission?: Permission;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'inventory:read' },
  { href: '/nodes', label: 'Nodes', icon: Server, permission: 'inventory:read' },
  { href: '/reports', label: 'Reports', icon: FileText, permission: 'reports:read' },
  {
    href: '/classification',
    label: 'Classification',
    icon: Layers,
    permission: 'classification:read',
  },
  /**
   * No permission. Settings opens on General, which holds "Change your
   * password" — and gating the whole destination on settings:manage meant a
   * viewer or operator could not change their own password from the console at
   * all. Each section inside gates itself; see settings/tabs.ts.
   */
  { href: '/settings', label: 'Settings', icon: Settings },
];

const STORAGE_KEY = 'nexuspuppet.sidebar.collapsed';

export function AppSidebar() {
  const pathname = usePathname();
  const { can, principal, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Read after mount rather than during render: touching localStorage on the
  // server would break hydration.
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === 'true');
  }, []);

  const toggle = () => {
    setCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-line-soft bg-panel transition-[width] duration-150',
        collapsed ? 'w-12' : 'w-52',
      )}
    >
      <div className="flex h-11 items-center gap-2 border-b border-line-soft px-3">
        <Boxes className="size-4 shrink-0 text-accent" aria-hidden />
        {!collapsed && (
          <span className="truncate text-sm font-semibold tracking-tight">NexusPuppet</span>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 p-1.5" aria-label="Main">
        {NAV.filter((item) => item.permission === undefined || can(item.permission)).map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded px-2 text-sm transition-colors',
                active
                  ? 'bg-panel-raised font-medium text-ink'
                  : 'text-ink-muted hover:bg-panel-raised hover:text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line-soft p-1.5">
        {!collapsed && principal !== null && (
          <div className="px-2 pb-1.5">
            <p className="truncate text-xs font-medium text-ink">{principal.displayName}</p>
            <p className="truncate text-[11px] text-ink-faint">{principal.role}</p>
          </div>
        )}

        <button
          type="button"
          onClick={() => void logout()}
          title={collapsed ? 'Sign out' : undefined}
          className="flex h-8 w-full items-center gap-2.5 rounded px-2 text-sm text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink"
        >
          <LogOut className="size-4 shrink-0" aria-hidden />
          {!collapsed && <span>Sign out</span>}
        </button>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="mt-0.5 flex h-8 w-full items-center gap-2.5 rounded px-2 text-sm text-ink-faint transition-colors hover:bg-panel-raised hover:text-ink"
        >
          <ChevronLeft
            className={cn('size-4 shrink-0 transition-transform', collapsed && 'rotate-180')}
            aria-hidden
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
