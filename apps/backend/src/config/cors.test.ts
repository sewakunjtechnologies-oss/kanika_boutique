import { describe, expect, test } from 'vitest';
import { buildAllowedOriginsFromInput } from './cors';

describe('CORS origin allow-list', () => {
  test('production allows only PUBLIC_DASHBOARD_URL', () => {
    expect(
      buildAllowedOriginsFromInput({
        nodeEnv: 'production',
        publicDashboardUrl: 'https://kanika-boutique-dashboard.vercel.app/',
        corsOrigin: 'https://evil.example.com',
        corsOrigins: 'https://dashboard.kanikaboutique.com,https://other.example.com',
        dashboardUrl: 'https://legacy.example.com',
      }),
    ).toEqual(['https://kanika-boutique-dashboard.vercel.app']);
  });

  test('development includes localhost and explicit dev origins', () => {
    expect(
      buildAllowedOriginsFromInput({
        nodeEnv: 'development',
        publicDashboardUrl: 'http://localhost:3030',
        corsOrigin: 'http://127.0.0.1:3030',
        corsOrigins: 'http://localhost:3000,http://localhost:3030',
      }),
    ).toEqual(['http://127.0.0.1:3030', 'http://localhost:3000', 'http://localhost:3030']);
  });
});
