import { basicAuth, publicAuth, type AuthProvider } from '@didww/verification-core';
import { Platform } from 'react-native';

const MOCK_API_PORT = '4000';

// A device is not the host machine: the Android emulator reaches it at 10.0.2.2 and the iOS
// simulator at localhost. Neither can reach 127.0.0.1 as printed by the mock API.
const defaultBaseUrl =
  Platform.OS === 'android'
    ? `http://10.0.2.2:${MOCK_API_PORT}`
    : `http://localhost:${MOCK_API_PORT}`;

export type AuthMode = 'public' | 'basic';

export const baseUrl = process.env.EXPO_PUBLIC_BASE_URL ?? defaultBaseUrl;

export const authMode: AuthMode =
  process.env.EXPO_PUBLIC_AUTH_MODE === 'public' ? 'public' : 'basic';

export const applicationKey = process.env.EXPO_PUBLIC_APPLICATION_KEY ?? '';

const applicationSecret = process.env.EXPO_PUBLIC_APPLICATION_SECRET ?? '';

/**
 * `application` auth is deliberately absent: it signs every request with the account secret, which
 * cannot be held on a device. Only these two are usable here, and only `public` is shippable.
 */
export function authProvider(): AuthProvider {
  return authMode === 'public'
    ? publicAuth(applicationKey)
    : basicAuth(applicationKey, applicationSecret);
}
