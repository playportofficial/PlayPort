import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Stack, router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, spacing, typeScale } from '@/constants/theme';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { checkIsRider, resolveRiderProfile } from '@/lib/riderFirestore';
import { useAppStore } from '@/store/appStore';
import { useRiderStore } from '@/store/riderStore';
import { useRiderLocationTracking } from '@/hooks/useRiderLocationTracking';

const NAV = [
  { href: '/rider', label: 'Available', match: (p: string) => p === '/rider' || p === '/rider/' },
  { href: '/rider/mine', label: 'My runs', match: (p: string) => p.startsWith('/rider/mine') },
  {
    href: '/rider/notifications',
    label: 'Alerts',
    match: (p: string) => p.startsWith('/rider/notifications'),
  },
] as const;

export default function RiderLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const bootstrap = useRiderStore((s) => s.bootstrap);
  const rider = useRiderStore((s) => s.rider);
  const mine = useRiderStore((s) => s.mine);
  // New-run, assignment and cancellation alerts share the customer inbox for this
  // auth uid, so the badge is just the unread count on it.
  const unreadAlerts = useAppStore((s) => s.notifications.filter((n) => !n.read).length);
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const desktop = width >= 900;

  const locationState = useRiderLocationTracking(allowed ? rider : null, allowed ? mine : []);
  const sharingLocation = mine.some(
    (order) => order.status === 'out_for_delivery' || order.status === 'returning'
  );

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      // Auth unresolved — stay on the spinner, never flash "sign in".
      if (!authReady) return;
      if (!isAuthenticated) {
        if (!cancelled) {
          setAllowed(false);
          setChecking(false);
        }
        return;
      }
      const ok = await checkIsRider();
      if (cancelled) return;
      if (ok) {
        const profile = await resolveRiderProfile();
        if (profile?.active) {
          setAllowed(true);
          cleanup = await bootstrap();
        } else {
          setAllowed(false);
        }
      } else {
        setAllowed(false);
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [authReady, isAuthenticated, bootstrap]);

  if (checking) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.playportOrange} />
        <Text style={styles.hint}>Checking rider access…</Text>
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.title}>Rider sign-in</Text>
        <Text style={styles.hint}>
          Use the same PlayPort OTP login with your registered delivery phone number.
        </Text>
        <Pressable
          style={styles.btn}
          onPress={() =>
            router.replace({ pathname: '/(auth)/login', params: { next: '/rider' } } as never)
          }
        >
          <Text style={styles.btnText}>Log in</Text>
        </Pressable>
      </View>
    );
  }

  if (!allowed) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.title}>Not a rider yet</Text>
        <Text style={styles.hint}>
          Ask ops to add your phone under Admin → Riders and mark you active. Then open /rider again.
        </Text>
        <Pressable style={styles.btn} onPress={() => router.replace('/(tabs)')}>
          <Text style={styles.btnText}>Back to shop</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={[styles.shell, desktop && styles.shellRow]}>
        <View style={[styles.nav, desktop && styles.navSide]}>
          <View style={styles.brandRow}>
            <View style={styles.brandLockup}>
              <BrandLogo size={28} />
              <Text style={styles.brand}>Rider</Text>
            </View>
            <Pressable onPress={() => router.push('/(tabs)')}>
              <Text style={styles.exit}>Exit</Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal={!desktop}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={desktop ? styles.navCol : styles.navRow}
          >
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Pressable
                  key={item.href}
                  style={[styles.navItem, active && styles.navItemActive]}
                  onPress={() => router.push(item.href as never)}
                >
                  <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                    {item.label}
                    {item.label === 'Alerts' && unreadAlerts ? ` · ${unreadAlerts}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {sharingLocation && locationState === 'denied' ? (
            <Text style={styles.locWarn}>
              Location is off, so customers cannot see a live arrival time. Allow location for this site and keep this tab open.
            </Text>
          ) : null}
          {sharingLocation && locationState === 'unavailable' ? (
            <Text style={styles.locWarn}>
              Waiting for a GPS fix. Keep this tab open in the foreground so the arrival time can update.
            </Text>
          ) : null}
        </View>
        <View style={styles.content}>
          <View style={styles.contentInner}>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="mine" />
              <Stack.Screen name="notifications" />
              <Stack.Screen name="order/[id]" />
            </Stack>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.page },
  shell: { flex: 1 },
  shellRow: { flexDirection: 'row' },
  nav: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  navSide: {
    width: 200,
    borderBottomWidth: 0,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: spacing.md,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brand: {
    fontFamily: fonts.heading,
    fontSize: typeScale.title,
    color: colors.primaryText,
  },
  exit: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.playportOrange,
  },
  navRow: { flexDirection: 'row', gap: spacing.sm, paddingBottom: spacing.sm },
  navCol: { flexDirection: 'column', gap: spacing.xs },
  navItem: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  navItemActive: { backgroundColor: colors.orangeTint },
  navLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.secondaryText,
  },
  navLabelActive: { color: colors.playportOrange },
  locWarn: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    paddingHorizontal: 12,
    paddingBottom: spacing.sm,
    lineHeight: 18,
  },
  content: { flex: 1, minWidth: 0 },
  contentInner: {
    flex: 1,
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: colors.page,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.md,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
    color: colors.primaryText,
    textAlign: 'center',
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    color: colors.secondaryText,
    textAlign: 'center',
    maxWidth: 400,
    lineHeight: 22,
  },
  btn: {
    marginTop: spacing.md,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.playportOrange,
  },
  btnText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.white,
  },
});
