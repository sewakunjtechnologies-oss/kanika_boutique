'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Home,
  Package,
  Tags,
  ShoppingCart,
  ReceiptText,
  MessagesSquare,
  Users,
  Settings,
  Printer,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

const NAV = [
  { href: '/', label: 'Dashboard', icon: Home },
  { href: '/orders', label: 'Orders', icon: ShoppingCart },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/manual-receipts', label: 'Manual Receipt', icon: ReceiptText },
  { href: '/categories', label: 'Categories', icon: Tags },
  { href: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/printer', label: 'Printer', icon: Printer },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Sidebar({ businessName }: { businessName: string }): React.ReactElement {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const logout = async (): Promise<void> => {
    await api.post('/api/auth/logout');
    window.location.href = '/login';
  };

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b bg-card px-3 md:hidden">
        <div>
          <div className="text-sm font-semibold">{businessName}</div>
          <div className="text-[11px] text-muted-foreground">Admin Dashboard</div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex size-10 items-center justify-center rounded-md border"
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </header>

      {open && (
        <div className="fixed inset-x-0 top-14 z-40 border-b bg-card p-3 shadow-sm md:hidden">
          <nav className="grid grid-cols-2 gap-2">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </Link>
              );
            })}
          </nav>
          <button
            onClick={logout}
            className="mt-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      )}

      <aside className="hidden md:flex md:w-56 md:flex-col md:fixed md:inset-y-0 md:border-r md:bg-card">
        <div className="px-6 py-5 border-b">
          <div className="text-lg font-semibold">{businessName}</div>
          <div className="text-xs text-muted-foreground">Admin Dashboard</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="px-3 py-4 border-t">
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
