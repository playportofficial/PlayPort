import { Caveat_700Bold } from '@expo-google-fonts/caveat';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import 'react-native-reanimated';

import { InstallAppBanner } from '@/components/pwa/InstallAppBanner';
import { colors } from '@/constants/theme';
import { useAppStore } from '@/store/appStore';
import { useCatalogStore } from '@/store/catalogStore';
import { useWishlistStore } from '@/store/wishlistStore';
import { registerWebPushIfAvailable } from '@/lib/fcm';
import { startAuthSessionKeepAlive } from '@/lib/firebase';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

SplashScreen.preventAutoHideAsync();

const PlayPortTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.playportOrange,
    background: colors.page,
    card: colors.surface,
    text: colors.primaryText,
    border: colors.border,
    notification: colors.badgeRed,
  },
};

export default function RootLayout() {
  const hydrateCatalog = useCatalogStore((s) => s.hydrate);
  const bootstrapAuth = useAppStore((s) => s.bootstrapAuth);
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const [loaded, error] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    Caveat_700Bold,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    // Don't block first paint on web fonts — hydrate ASAP, fonts swap in.
    SplashScreen.hideAsync();
    void hydrateCatalog();
    void useWishlistStore.getState().hydrate();
  }, [hydrateCatalog]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  useEffect(() => {
    const unsub = bootstrapAuth();
    const stopKeepAlive = startAuthSessionKeepAlive();
    return () => {
      unsub();
      stopKeepAlive();
    };
  }, [bootstrapAuth]);

  useEffect(() => {
    if (isAuthenticated) {
      void registerWebPushIfAvailable();
    }
  }, [isAuthenticated]);

  // Web: render immediately. Native: wait for fonts to avoid layout flash.
  if (!loaded && Platform.OS !== 'web') {
    return null;
  }

  return (
    <ThemeProvider value={PlayPortTheme}>
      <StatusBar style="dark" />
      <InstallAppBanner />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.page },
          animation: 'fade_from_bottom',
          animationDuration: 280,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="admin" options={{ animation: 'fade' }} />
        <Stack.Screen name="rider" options={{ animation: 'fade' }} />
        <Stack.Screen name="search/index" options={{ animation: 'fade' }} />
        <Stack.Screen name="search/results" />
        <Stack.Screen name="product/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="experience/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="wishlist" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="checkout/index" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="checkout/payment" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="checkout/confirmation" options={{ animation: 'fade' }} />
        <Stack.Screen name="address/index" />
        <Stack.Screen name="address/add" />
        <Stack.Screen name="address/edit/[id]" />
        <Stack.Screen name="order/[id]" />
        <Stack.Screen name="order/track/[id]" />
        <Stack.Screen name="order/cancel/[id]" />
        <Stack.Screen name="profile/addresses" />
        <Stack.Screen name="profile/payment-methods" />
        <Stack.Screen name="profile/notifications" />
        <Stack.Screen name="profile/settings" />
        <Stack.Screen name="profile/help" />
        <Stack.Screen name="profile/reviews" />
        <Stack.Screen name="modal" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      </Stack>
    </ThemeProvider>
  );
}
