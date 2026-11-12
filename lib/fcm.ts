import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { Platform } from 'react-native';
import { firebaseApp } from '@/lib/firebase';
import { callRegisterFcmToken } from '@/lib/functions';

/**
 * Why a device may never receive a push, in a form the UI can explain:
 * - unsupported: no service worker / not a browser (native builds included)
 * - no-key: EXPO_PUBLIC_FIREBASE_VAPID_KEY is empty, so FCM cannot mint a token
 * - blocked: the browser or the user denied notification permission
 * - error: registration threw (see console)
 */
export type WebPushState = 'granted' | 'no-key' | 'blocked' | 'unsupported' | 'error';

/**
 * Registers this browser for FCM web push and stores the token on the signed-in
 * user. Must be called from a user gesture the first time (Chrome ignores
 * permission prompts raised during load), which is what the rider Alerts tab does.
 */
export async function enableWebPush(): Promise<WebPushState> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return 'unsupported';
  try {
    if (!(await isSupported())) return 'unsupported';

    const vapid = process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY;
    if (!vapid) {
      console.warn('FCM: EXPO_PUBLIC_FIREBASE_VAPID_KEY is empty — web push cannot register.');
      return 'no-key';
    }

    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return 'blocked';
    }

    const token = await getToken(getMessaging(firebaseApp), { vapidKey: vapid });
    if (!token) return 'error';
    await callRegisterFcmToken(token);
    return 'granted';
  } catch (err) {
    console.warn('FCM register failed', err);
    return 'error';
  }
}

/** Fire-and-forget registration used on sign-in. */
export async function registerWebPushIfAvailable() {
  return enableWebPush();
}
