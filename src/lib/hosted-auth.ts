import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface HostedAuthStatus {
  configured: boolean;
  phase: 'signed_out' | 'pending' | 'signed_in';
  userCode: string | null;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  expiresIn: number | null;
  error: string | null;
}

export const hostedConfigured = Boolean(import.meta.env.VITE_CONVEX_URL);
export const getHostedAuthStatus = () => invoke<HostedAuthStatus>('get_hosted_auth_status');
export const startHostedSignIn = () => invoke<HostedAuthStatus>('start_hosted_sign_in');
export const cancelHostedSignIn = () => invoke<HostedAuthStatus>('cancel_hosted_sign_in');
export const signOutHostedAuth = () => invoke<HostedAuthStatus>('sign_out_hosted_auth');
export const getHostedAuthToken = () => invoke<string | null>('get_hosted_auth_token');

export async function openHostedSignInBrowser(status: HostedAuthStatus): Promise<void> {
  const url = status.verificationUriComplete ?? status.verificationUri;
  if (status.phase !== 'pending' || !url || new URL(url).protocol !== 'https:') throw new Error('No browser sign-in is available.');
  await getCurrentWindow().setAlwaysOnTop(false);
  await openUrl(url);
}
