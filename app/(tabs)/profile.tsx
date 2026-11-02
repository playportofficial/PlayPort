import { useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AuthLoadingScreen } from '@/components/auth/AuthLoadingScreen';
import { Screen } from '@/components/layout/Screen';
import { LegalLinks } from '@/components/legal/LegalLinks';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useNow } from '@/hooks/useNow';
import { useResponsive } from '@/hooks/useResponsive';
import { checkIsAdmin } from '@/lib/adminAuth';
import { checkIsRider } from '@/lib/riderFirestore';
import { useAppStore } from '@/store/appStore';
import { isEnRoute, remainingEtaMinutes } from '@/utils/liveEta';
import { needsOnboarding } from '@/utils/onboarding';

type MenuItem = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href?: string;
  danger?: boolean;
  onPress?: () => void;
};

type MenuSection = {
  title: string;
  items: MenuItem[];
};

export default function ProfileScreen() {
  const { horizontalPadding, isDesktop, gap } = useResponsive();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const user = useAppStore((s) => s.user);
  const addresses = useAppStore((s) => s.addresses);
  const orders = useAppStore((s) => s.orders);
  const logout = useAppStore((s) => s.logout);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isRider, setIsRider] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsAdmin(false);
      setIsRider(false);
      return;
    }
    let cancelled = false;
    void Promise.all([checkIsAdmin(true), checkIsRider()]).then(([adminOk, riderOk]) => {
      if (!cancelled) {
        setIsAdmin(adminOk);
        setIsRider(riderOk);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const activeOrder = orders.find((o) =>
    ['confirmed', 'preparing', 'out_for_delivery', 'delivered', 'active', 'returning'].includes(o.status)
  );
  const now = useNow(isEnRoute(activeOrder?.status));
  const liveMinutes = remainingEtaMinutes(activeOrder, now);

  const showSetup = isAuthenticated && user && needsOnboarding(user, addresses);

  const sections: MenuSection[] = useMemo(() => {
    if (!user) return [];
    const base: MenuSection[] = [
      {
        title: 'My Activity',
        items: [
          { label: 'Wishlist', icon: 'heart-outline', href: '/wishlist' },
          { label: 'My Orders', icon: 'cube-outline', href: '/(tabs)/orders' },
          { label: 'Past rentals', icon: 'time-outline', href: '/(tabs)/orders' },
          { label: 'My Reviews', icon: 'star-outline', href: '/profile/reviews' },
        ],
      },
      {
        title: 'Account',
        items: [
          { label: 'Saved Addresses', icon: 'location-outline', href: '/profile/addresses' },
          { label: 'Payment Methods', icon: 'card-outline', href: '/profile/payment-methods' },
          { label: 'Notifications', icon: 'notifications-outline', href: '/profile/notifications' },
        ],
      },
      {
        title: 'Security',
        items: [
          {
            label: 'Edit profile',
            icon: 'person-outline',
            href: '/profile/account',
          },
          {
            label: user.kycVerified ? 'Account verified' : 'Account',
            icon: 'shield-checkmark-outline',
            href: '/profile/account',
          },
        ],
      },
      {
        title: 'Support',
        items: [
          { label: 'Help & FAQs', icon: 'help-circle-outline', href: '/profile/help' },
          { label: 'Sanitization Promise', icon: 'sparkles-outline', href: '/profile/sanitization' },
          { label: 'Settings', icon: 'settings-outline', href: '/profile/settings' },
        ],
      },
      {
        title: 'Legal',
        items: [
          { label: 'Terms & Conditions', icon: 'document-text-outline', href: '/legal/terms' },
          { label: 'Privacy Policy', icon: 'lock-closed-outline', href: '/legal/privacy' },
          { label: 'Refund & Cancellation Policy', icon: 'return-down-back-outline', href: '/legal/refunds' },
        ],
      },
    ];
    if (isAdmin) {
      base.unshift({
        title: 'Ops',
        items: [{ label: 'Admin panel', icon: 'construct-outline', href: '/admin' }],
      });
    }
    if (isRider) {
      base.unshift({
        title: 'Delivery',
        items: [{ label: 'Rider portal', icon: 'bicycle-outline', href: '/rider' }],
      });
    }
    return base;
  }, [isAdmin, isRider, user]);

  if (!authReady) return <AuthLoadingScreen />;

  if (!isAuthenticated || !user) {
    return (
      <Screen showCart={false} pageTitle="Profile" showDelivery={false}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
        >
          <Card style={styles.guestCard} elevated>
            <Text style={styles.guestTitle}>Browse as a guest</Text>
            <Text style={styles.guestSub}>
              Log in to save addresses, place orders, and track deliveries in real time.
            </Text>
            <Button title="Log in" fullWidth onPress={() => router.push('/(auth)/login')} />
          </Card>
          <LegalLinks />
        </ScrollView>
      </Screen>
    );
  }

  return (
      <Screen showCart={false} pageTitle="Profile" showDelivery={false}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
      >
        {showSetup ? (
          <Card style={styles.setupCard} elevated>
            <Text style={styles.setupTitle}>Finish your profile</Text>
            <Text style={styles.setupSub}>
              Add your name and a delivery address so we can route kits to you.
            </Text>
            <Button
              title="Complete setup"
              fullWidth
              onPress={() => router.push('/(auth)/onboarding' as never)}
            />
          </Card>
        ) : null}

        <View style={[styles.desktopSplit, isDesktop && styles.desktopSplitRow, isDesktop && { gap }]}>
          <View style={[styles.desktopCol, isDesktop && styles.desktopColLeft]}>
            <Card style={styles.userCard} elevated>
              <View style={styles.userRow}>
                <Image
                  source={{ uri: user.avatar }}
                  style={styles.avatar}
                  contentFit="cover"
                />
                <View style={styles.userMeta}>
                  <Text style={styles.userName}>{user.name}</Text>
                  <Text style={styles.userPhone}>{user.phone}</Text>
                  {user.email ? <Text style={styles.userEmail}>{user.email}</Text> : null}
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
                onPress={() => router.push('/profile/account' as never)}
                style={styles.editProfileBtn}
              >
                <Ionicons name="pencil-outline" size={16} color={colors.playportOrange} />
                <Text style={styles.editProfileText}>Edit profile</Text>
              </Pressable>
            </Card>

            {activeOrder ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/order/track/${activeOrder.id}`)}
              >
                <Card style={styles.trackCard} elevated>
                  <View style={styles.trackTop}>
                    <Badge
                      label="ACTIVE ORDER"
                      color={colors.playportOrange}
                      backgroundColor={colors.orangeTint}
                    />
                    <Ionicons name="chevron-forward" size={18} color={colors.secondaryText} />
                  </View>
                  <Text style={styles.trackTitle}>Track #{activeOrder.id}</Text>
                  <Text style={styles.trackMeta}>
                    {isEnRoute(activeOrder.status) && liveMinutes != null
                      ? `${liveMinutes} min away`
                      : activeOrder.etaLabel}{' '}
                    · {activeOrder.items[0]?.name}
                  </Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${activeOrder.progressPercent}%` }]} />
                  </View>
                </Card>
              </Pressable>
            ) : null}
          </View>

          <View style={[styles.desktopCol, isDesktop && styles.desktopColRight]}>
            {sections.map((section) => (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Card padded={false}>
                  {section.items.map((item, index) => (
                    <Pressable
                      key={item.label}
                      accessibilityRole="button"
                      onPress={() => {
                        if (item.onPress) item.onPress();
                        else if (item.href) router.push(item.href as never);
                      }}
                      style={[
                        styles.menuRow,
                        index < section.items.length - 1 && styles.menuBorder,
                      ]}
                    >
                      <View
                        style={[
                          styles.menuIcon,
                          item.danger && { backgroundColor: colors.dangerBg },
                        ]}
                      >
                        <Ionicons
                          name={item.icon}
                          size={18}
                          color={item.danger ? colors.danger : colors.secondaryText}
                        />
                      </View>
                      <Text style={[styles.menuLabel, item.danger && { color: colors.danger }]}>
                        {item.label}
                      </Text>
                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={item.danger ? colors.danger : colors.mutedText}
                      />
                    </Pressable>
                  ))}
                </Card>
              </View>
            ))}

            <Button
              title="Log out"
              variant="danger"
              fullWidth
              style={styles.logout}
              icon={<Ionicons name="log-out-outline" size={18} color={colors.danger} />}
              onPress={() => setConfirmLogout(true)}
            />
          </View>
        </View>
      </ScrollView>
      <Modal visible={confirmLogout} transparent animationType="fade" onRequestClose={() => setConfirmLogout(false)}>
        <View style={styles.logoutScrim}>
          <View style={styles.logoutCard}>
            <Text style={styles.logoutTitle}>Log out?</Text>
            <Text style={styles.logoutBody}>
              Your saved address stays on this account. You can log back in with the same number.
            </Text>
            <Button
              title="Yes, log out"
              variant="danger"
              fullWidth
              onPress={() => {
                setConfirmLogout(false);
                logout();
                router.replace('/(tabs)');
              }}
            />
            <Button title="Stay logged in" variant="ghost" fullWidth onPress={() => setConfirmLogout(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxxl, gap: spacing.lg, paddingTop: spacing.sm },
  titleBlock: { gap: 2 },
  eyebrow: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  pageTitle: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.display,
    letterSpacing: -0.4,
  },
  guestCard: { gap: spacing.md },
  guestTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  guestSub: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 20,
  },
  setupCard: { gap: spacing.md },
  setupTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  setupSub: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 20,
  },
  desktopSplit: { gap: spacing.lg },
  desktopSplitRow: { flexDirection: 'row', alignItems: 'flex-start' },
  desktopCol: { gap: spacing.lg },
  desktopColLeft: { flex: 1, minWidth: 0 },
  desktopColRight: { flex: 1.15, minWidth: 0 },
  userCard: { gap: spacing.md },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceAlt,
  },
  userMeta: { flex: 1, gap: 4 },
  userName: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  userPhone: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  userEmail: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.small },
  editProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: colors.orangeTint,
  },
  editProfileText: { color: colors.playportOrange, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  statsRow: { flexDirection: 'row', gap: 10 },
  statsRowDesktop: { gap: 14 },
  stat: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 72,
    gap: 4,
  },
  statValue: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title },
  statLabel: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.caption },
  trackCard: {
    gap: spacing.sm,
  },
  trackTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  trackTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title },
  trackMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: { height: '100%', backgroundColor: colors.playportOrange, borderRadius: 2 },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  menuBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: { flex: 1, color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.bodyLg },
  logout: { marginTop: spacing.xl },
  logoutScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  logoutCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  logoutTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title },
  logoutBody: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body, lineHeight: 22 },
});
