/** @type {import('next').NextConfig} */

// The dashboard proxies API + uploaded-media requests to the backend so the browser
// only ever talks to this (the dashboard's) origin. That keeps the session cookie
// first-party, which is required for iOS Safari — it blocks third-party cookies even
// when SameSite=None; Secure is set. Socket.IO is NOT proxied here (Vercel can't proxy
// WebSockets); it connects directly to the backend with a handshake token.
const backendOrigin = (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3031').replace(/\/+$/, '');

const nextConfig = {
  async rewrites() {
    return [
      // REST API + uploads POST/GET (the backend serves uploads under /api/uploads/*).
      { source: '/api/:path*', destination: `${backendOrigin}/api/:path*` },
      // Product images are stored as "/uploads/..."; map them onto the backend's
      // "/api/uploads/..." handler so <img src="/uploads/..."> resolves same-origin.
      { source: '/uploads/:path*', destination: `${backendOrigin}/api/uploads/:path*` },
    ];
  },
};

export default nextConfig;
