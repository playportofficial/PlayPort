import { useEffect } from 'react';
import { Platform } from 'react-native';
import { goHome } from '@/utils/navigation';

/**
 * After checkout succeeds (or any “done” screen), the browser Back button must
 * not revive payment/review. We push a sentinel history entry and, on popstate,
 * send the customer home — same idea as closing a completed order flow in big apps.
 *
 * Pass `onExit` (e.g. leaveCheckout) when abandoning an unpaid flow so pending
 * resume state is cleared too.
 */
export function useExitToHomeOnBack(enabled = true, onExit: () => void = goHome) {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return;

    const onPopState = () => {
      // Re-arm so repeated Back presses keep exiting to home instead of digging
      // into cart → checkout → payment underneath.
      window.history.pushState({ playportExitHome: true }, '');
      onExit();
    };

    window.history.pushState({ playportExitHome: true }, '');
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [enabled, onExit]);
}
