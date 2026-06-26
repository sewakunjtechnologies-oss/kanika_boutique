import { ApiError } from './api';

export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'authenticated'; user: DashboardUser }
  | { status: 'unauthenticated'; user: null }
  | { status: 'error'; user: null; message: string };

export interface AuthMeResponse {
  authenticated: true;
  user: DashboardUser;
}

export async function restoreAuthSession(
  fetchMe: () => Promise<AuthMeResponse>,
): Promise<AuthState> {
  try {
    const response = await fetchMe();
    return { status: 'authenticated', user: response.user };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { status: 'unauthenticated', user: null };
    }
    return { status: 'error', user: null, message: 'Could not verify your session. Refresh the page and try again.' };
  }
}

export function shouldRedirectToLogin(state: AuthState): boolean {
  return state.status === 'unauthenticated';
}
