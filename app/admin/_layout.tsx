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
import { checkIsAdmin } from '@/lib/adminAuth';
import { useAdminStore } from '@/store/adminStore';
import { useAppStore } from '@/store/appStore';

const NAV = [
  { href: '/admin', label: 'Overview', match: (p: string) => p === '/admin' || p === '/admin/' },
  { href: '/admin/products', label: 'Products', match: (p: string) => p.startsWith('/admin/products') },
  { href: '/admin/combos', label: 'Combos', match: (p: string) => p.startsWith('/admin/combos') },
  { href: '/admin/categories', label: 'Categories', match: (p: string) => p.startsWith('/admin/categories') },
  { href: '/admin/inventory', label: 'Inventory', match: (p: string) => p.startsWith('/admin/inventory') },
  { href: '/admin/hubs', label: 'Hubs', match: (p: string) => p.startsWith('/admin/hubs') },
  { href: '/admin/orders', label: 'Deliveries', match: (p: string) => p.startsWith('/admin/orders') },
  { href: '/admin/payments', label: 'Payments', match: (p: string) => p.startsWith('/admin/payments') },
  { href: '/admin/customers', label: 'Customers', match: (p: string) => p.startsWith('/admin/customers') },
  { href: '/admin/riders', label: 'Riders', match: (p: string) => p.startsWith('/admin/riders') },
  { href: '/admin/reviews', label: 'Reviews', match: (p: string) => p.startsWith('/admin/reviews') },
  { href: '/admin/feedback', label: 'Feedback', match: (p: string) => p.startsWith('/admin/feedback') },
  { href: '/admin/settings', label: 'Settings', match: (p: string) => p.startsWith('/admin/settings') },
] as const;

export default function AdminLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const hydrateAll = useAdminStore((s) => s.hydrateAll);
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [checkTick, setCheckTick] = useState(0);
  const desktop = width >= 960;

  useEffect(() => {
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
      if (!cancelled) setChecking(true);
      const ok = await checkIsAdmin(true);
      if (!cancelled) {
        setAllowed(ok);
        setChecking(false);
        if (ok) void hydrateAll();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, isAuthenticated, hydrateAll, checkTick]);

  if (checking) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.playportOrange} />
        <Text style={styles.hint}>Checking admin access…</Text>
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.deniedTitle}>Sign in required</Text>
        <Text style={styles.hint}>Log in with your ops phone number, then open /admin again.</Text>
        <Pressable
          style={styles.linkBtn}
          onPress={() =>
            router.replace({ pathname: '/(auth)/login', params: { next: '/admin' } })
          }
        >
          <Text style={styles.linkText}>Go to login</Text>
        </Pressable>
      </View>
    );
  }

  if (!allowed) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.deniedTitle}>Admin only</Text>
        <Text style={styles.hint}>
          Your account is not an admin yet, or your session is stale. If access was just granted, tap
          Retry access, or sign out and sign in again.
        </Text>
        <Pressable
          style={styles.linkBtn}
          onPress={() => {
            setChecking(true);
            setCheckTick((n) => n + 1);
          }}
        >
          <Text style={styles.linkText}>Retry access</Text>
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={() => router.replace('/(tabs)')}>
          <Text style={styles.linkText}>Back to app</Text>
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
              <Text style={styles.brand}>Ops</Text>
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
                  <Text style={[styles.navLabel, active && styles.navLabelActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <View style={styles.content}>
          <View style={styles.contentInner}>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="products/index" />
              <Stack.Screen name="products/[id]" />
              <Stack.Screen name="combos/index" />
              <Stack.Screen name="combos/[id]" />
              <Stack.Screen name="categories/index" />
              <Stack.Screen name="inventory/index" />
              <Stack.Screen name="hubs/index" />
              <Stack.Screen name="orders/index" />
              <Stack.Screen name="orders/[id]" />
              <Stack.Screen name="payments" />
              <Stack.Screen name="customers/index" />
              <Stack.Screen name="riders/index" />
              <Stack.Screen name="reviews/index" />
              <Stack.Screen name="feedback/index" />
              <Stack.Screen name="settings/index" />
            </Stack>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.page,
  },
  shell: {
    flex: 1,
  },
  shellRow: {
    flexDirection: 'row',
  },
  nav: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  navSide: {
    width: 220,
    maxWidth: '32%',
    minWidth: 180,
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
  navRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  navCol: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  navItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  navItemActive: {
    backgroundColor: colors.orangeTint,
  },
  navLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.secondaryText,
  },
  navLabelActive: {
    color: colors.playportOrange,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  contentInner: {
    flex: 1,
    width: '100%',
    maxWidth: 1120,
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
  deniedTitle: {
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
    maxWidth: 420,
    lineHeight: 22,
  },
  mono: {
    fontFamily: fonts.mono,
    color: colors.primaryText,
  },
  linkBtn: {
    marginTop: spacing.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.orangeTint,
  },
  linkText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.playportOrange,
  },
});

