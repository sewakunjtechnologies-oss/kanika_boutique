'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { type AuthMeResponse, type AuthState, restoreAuthSession, shouldRedirectToLogin } from '@/lib/auth-state';

export function AuthGuard({ children }: { children: React.ReactNode }): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [authState, setAuthState] = useState<AuthState>({ status: 'loading', user: null });

  useEffect(() => {
    let cancelled = false;
    setAuthState({ status: 'loading', user: null });
    void restoreAuthSession(() =>
      api.get<AuthMeResponse>('/api/auth/me', {
        redirectOnUnauthorized: false,
        cache: 'no-store',
      }),
    ).then((state) => {
      if (cancelled) return;
      setAuthState(state);
      if (shouldRedirectToLogin(state)) {
        const qs = searchParams.toString();
        const next = encodeURIComponent(`${pathname}${qs ? `?${qs}` : ''}`);
        router.replace(`/login?next=${next}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pathname, router, searchParams]);

  if (authState.status === 'error') {
    return (
      <div className="text-sm text-muted-foreground">
        {authState.message}
      </div>
    );
  }

  if (authState.status !== 'authenticated') {
    return <div className="text-sm text-muted-foreground">Checking session...</div>;
  }

  return <>{children}</>;
}
