'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';

export default function LoginPage(): React.ReactElement {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm(): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/api/auth/login', { email, password });
      await api.get('/api/auth/me');
      router.replace(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        toast.error('Wrong email or password');
      } else {
        toast.error('Login failed — is the backend running?');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <LoginShell
      email={email}
      password={password}
      loading={loading}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={onSubmit}
    />
  );
}

function LoginShell({
  email = '',
  password = '',
  loading = false,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: {
  email?: string;
  password?: string;
  loading?: boolean;
  onEmailChange?: (value: string) => void;
  onPasswordChange?: (value: string) => void;
  onSubmit?: (e: React.FormEvent) => void;
}): React.ReactElement {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-3 py-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Kanika Designs</CardTitle>
          <CardDescription>Sign in to the admin dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => onEmailChange?.(e.target.value)}
                readOnly={!onEmailChange}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => onPasswordChange?.(e.target.value)}
                readOnly={!onPasswordChange}
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" disabled={loading} className="w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
