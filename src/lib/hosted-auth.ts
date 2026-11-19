import { isTauri } from '@tauri-apps/api/core';
import type { Clerk } from '@clerk/clerk-js';

export const hostedConfigured = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY && import.meta.env.VITE_CONVEX_URL);
let clerkPromise: Promise<Clerk> | undefined;

export function getHostedClerk(): Promise<Clerk> | undefined {
  if (!hostedConfigured) return undefined;
  clerkPromise ??= (async () => {
    const { ui } = await import('@clerk/ui');
    if (isTauri()) {
      const { initClerk, noopLogger } = await import('tauri-plugin-clerk');
      return initClerk({ ui }, noopLogger());
    }
    const { Clerk } = await import('@clerk/clerk-js');
    const clerk = new Clerk(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
    await clerk.load({ ui });
    return clerk;
  })().catch(error => { clerkPromise = undefined; throw error; });
  return clerkPromise;
}
