import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useAppStore } from '@/store/appStore';

/** App home (shop tabs). Prefer replace so Back never re-enters a finished flow. */
export const HOME_HREF = '/(tabs)' as const;

/** Leave the current screen for home without leaving a back-stack trap. */
export function goHome() {
  router.replace(HOME_HREF as never);
}

/**
 * Exit checkout the way large apps do: drop the payment/review stack and land
 * on home. Clears an unpaid hold resume so Back never reopens “continue payment”.
 */
export function leaveCheckout() {
  useAppStore.setState({ pendingOrderId: null, paymentError: null });
  goHome();
}

/** Web-only: true when the browser can walk history backward. */
export function canUseBrowserHistory(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined';
}
