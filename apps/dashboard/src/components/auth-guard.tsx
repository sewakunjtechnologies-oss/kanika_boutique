'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export function AuthGuard({ children }: { children: React.ReactNode }): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/me')
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          const qs = searchParams.toString();
          const next = encodeURIComponent(`${pathname}${qs ? `?${qs}` : ''}`);
          router.replace(`/login?next=${next}`);
          return;
        }
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router, searchParams]);

  if (error) {
    return (
      <div className="text-sm text-muted-foreground">
        Could not verify your session. Refresh the page and try again.
      </div>
    );
  }

  if (!ready) {
    return <div className="text-sm text-muted-foreground">Checking session...</div>;
  }

  return <>{children}</>;
}
