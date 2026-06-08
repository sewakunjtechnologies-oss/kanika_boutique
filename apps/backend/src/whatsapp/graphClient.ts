import axios, { type AxiosInstance, type AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { env } from '../config/env';
import { logger } from '../logger';

const BASE_URL = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

export const graphApi: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: env.META_ACCESS_TOKEN ? { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` } : {},
});

axiosRetry(graphApi, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err: AxiosError): boolean => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
    const status = err.response?.status;
    if (status === 429) return true;
    if (status !== undefined && status >= 500 && status < 600) return true;
    return false;
  },
  onRetry: (count, err) => {
    logger.warn(
      { attempt: count, status: err.response?.status, url: err.config?.url },
      'graph api retry',
    );
  },
});

// Pull the most useful info out of an axios error for logs / rethrow.
export function describeGraphError(err: unknown): { status?: number; data?: unknown; message: string } {
  if (axios.isAxiosError(err)) {
    return {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
