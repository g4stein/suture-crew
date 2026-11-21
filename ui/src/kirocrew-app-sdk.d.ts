/**
 * Types for the parts of `@kirocrew/app-sdk` this page uses. The dashboard provides the module at runtime through its
 * import map (it is not an npm package). Signatures copied from kirodotdev/KiroCrew website/src/app-sdk (scopedApi.ts
 * `AppApi`, index.ts `useAppApi`, `useNotify`, `useChatLauncher`, `ChatLaunchOptions`). A running dashboard serves the
 * complete declarations at /vendor/kirocrew-app-sdk.d.ts.
 */
declare module '@kirocrew/app-sdk' {
  export interface AppApi {
    raw(path: string, init?: RequestInit): Promise<Response>;
    request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
    get<T = unknown>(path: string, init?: RequestInit): Promise<T>;
    post<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
    put<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
    patch<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
    del<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  }

  export interface AppApiError extends Error {
    readonly status: number;
    readonly body: string;
  }

  export interface ChatLaunchOptions {
    agent?: string;
    message?: string;
    slotKey?: string;
    autoSend?: boolean;
  }

  export function useAppApi(): AppApi;
  export function useNotify(): (message: string, opts?: { type?: 'info' | 'success' | 'error' }) => void;
  export function useChatLauncher(): { openChat: (opts?: ChatLaunchOptions) => void };
}
