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
let browserLoweredOverlay = false;

async function restoreSignInWindow(status: HostedAuthStatus): Promise<HostedAuthStatus> {
  if (status.phase !== 'pending') await restoreHostedSignInWindow(status.phase === 'signed_in');
  return status;
}

export async function restoreHostedSignInWindow(focus = false): Promise<void> {
  if (browserLoweredOverlay) {
    const window = getCurrentWindow();
    await window.setAlwaysOnTop(true);
    browserLoweredOverlay = false;
    if (focus) await window.setFocus();
  }
}

export const getHostedAuthStatus = async () => restoreSignInWindow(await invoke<HostedAuthStatus>('get_hosted_auth_status'));
export const startHostedSignIn = () => invoke<HostedAuthStatus>('start_hosted_sign_in');
export const cancelHostedSignIn = async () => restoreSignInWindow(await invoke<HostedAuthStatus>('cancel_hosted_sign_in'));
export const signOutHostedAuth = async () => restoreSignInWindow(await invoke<HostedAuthStatus>('sign_out_hosted_auth'));
export const getHostedAuthToken = () => invoke<string | null>('get_hosted_auth_token');

export async function openHostedSignInBrowser(status: HostedAuthStatus): Promise<void> {
  const url = status.verificationUriComplete ?? status.verificationUri;
  if (status.phase !== 'pending' || !url || new URL(url).protocol !== 'https:') throw new Error('No browser sign-in is available.');
  const window = getCurrentWindow();
  try {
    if (window.label === 'main') {
      browserLoweredOverlay = true;
      await window.setAlwaysOnTop(false);
    }
    await openUrl(url);
  }
  catch (error) {
    await restoreHostedSignInWindow();
    throw error;
  }
}
