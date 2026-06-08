import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return NextResponse.next();

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (backendUrl && !areSameSiteUrls(backendUrl, request.nextUrl.origin)) {
    return NextResponse.next();
  }

  const token = request.cookies.get('kda_session');
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function areSameSiteUrls(a: string, b: string): boolean {
  try {
    return siteKey(new URL(a).hostname) === siteKey(new URL(b).hostname);
  } catch {
    return false;
  }
}

function siteKey(host: string): string {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return host;
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}
