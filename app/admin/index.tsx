import { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { colors, fonts, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAdminStore } from '@/store/adminStore';
import { formatSlotTime } from '@/utils/serviceHours';
import type { OpsNotification } from '@/types';

function timeLabel(iso: string | null | undefined, now: Date) {
  if (!iso) return '';
  const then = new Date(iso);
  const diff = Math.round((now.getTime() - then.getTime()) / 60000);
  if (!Number.isFinite(diff)) return '';
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 120) return 'about an hour ago';
  const h = Math.round(diff / 60);
  if (h < 24) return `${h}h ago`;
  return formatSlotTime(iso);
}

export default function AdminOverviewScreen() {
  const { horizontalPadding } = useResponsive();
  const loading = useAdminStore((s) => s.loading);
  const counts = useAdminStore((s) => s.counts);
  const config = useAdminStore((s) => s.config);
  const error = useAdminStore((s) => s.error);
  const hydrateAll = useAdminStore((s) => s.hydrateAll);
  const opsNotifications = useAdminStore((s) => s.opsNotifications);
  const loadOpsNotifications = useAdminStore((s) => s.loadOpsNotifications);
  const markAllOpsNotificationsRead = useAdminStore((s) => s.markAllOpsNotificationsRead);
  const requestAdminNotificationPermission = useAdminStore((s) => s.requestAdminNotificationPermission);
  const unreadOps = opsNotifications.filter((n: OpsNotification) => !n.read);
  const latestNewOrder = unreadOps.find(
    (n: OpsNotification) => n.kind === 'new_order' || n.kind === 'dispatch'
  ) || null;

  // Light poll so the admin tab notices new orders without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      if (cancelled) return;
      void loadOpsNotifications().then(() => {
        if (cancelled) return;
        const newest = useAdminStore.getState().opsNotifications[0];
        if (newest && typeof document !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification(`PlayPort admin`, {
              body: `${newest.title} — ${newest.body}`,
              tag: 'playport-admin-alert',
              requireInteraction: true,
            });
          } catch {
            /* browser may deny silent notifications */
          }
        }
      });
    };
    poll();
    timer = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [loadOpsNotifications]);


  const showPermissionBanner = typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default';

  const cards = [
    { label: 'Products', value: counts?.products ?? '—', href: '/admin/products' },
    { label: 'Combos', value: counts?.experiences ?? '—', href: '/admin/combos' },
    { label: 'Categories', value: counts?.categories ?? '—', href: '/admin/categories' },
    {
      label: 'Available units',
      value: counts ? `${counts.availableUnits}/${counts.totalUnits}` : '—',
      href: '/admin/inventory',
    },
    { label: 'Open deliveries', value: counts?.openOrders ?? '—', href: '/admin/orders' },
    { label: 'Payments', value: 'Ledger', href: '/admin/payments' },
    { label: 'Hubs', value: counts?.hubs ?? '—', href: '/admin/hubs' },
    { label: 'Reviews', value: counts?.reviews ?? '—', href: '/admin/reviews' },
    { label: 'Feedback', value: 'Inbox', href: '/admin/feedback' },
    { label: 'Ordering', value: config.maintenanceMode ? 'Paused' : 'Live', href: '/admin/settings' },
  ];

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[adminStyles.scroll, { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl }]}
    >
      <View style={adminStyles.row}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={adminStyles.title}>Overview</Text>
            {unreadOps.length > 0 ? (
              <View style={styles.unreadChip}>
                <Text style={styles.unreadChipText}>{unreadOps.length} new</Text>
              </View>
            ) : null}
          </View>
          <Text style={adminStyles.subtitle}>Full catalog, inventory, customers, and ops knobs</Text>
        </View>
        <Pressable style={styles.refresh} onPress={() => void hydrateAll()}>
          <Text style={styles.refreshText}>Refresh</Text>
        </Pressable>
      </View>

      {config.maintenanceMode ? (
        <View style={styles.warn}>
          <Text style={styles.warnTitle}>Ordering is paused</Text>
          <Text style={styles.warnBody}>{config.maintenanceMessage}</Text>
        </View>
      ) : null}

      {latestNewOrder ? (
        <View style={[styles.alert, { marginHorizontal: horizontalPadding }]}>
          <View style={styles.alertRow}>
            <View style={styles.alertBody}>
              <Text style={styles.alertTitle}>New order landed</Text>
              <Text style={styles.alertText}>
                {latestNewOrder.title} · {latestNewOrder.body}
              </Text>
              <Text style={styles.alertMeta}>{timeLabel(latestNewOrder.createdAt, new Date())}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark read"
              onPress={() => void markAllOpsNotificationsRead()}
            >
              <Text style={styles.alertDismiss}>Mark read</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={adminStyles.error}>{error}</Text> : null}
      {showPermissionBanner ? (
        <View style={[styles.banner, { marginHorizontal: horizontalPadding }]}>
          <Text style={styles.bannerText}>Turn on browser notifications for the admin app so new orders reach this tab.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Enable notifications"
            onPress={async () => {
              const granted = await requestAdminNotificationPermission();
              if (granted) {
                await loadOpsNotifications();
              }
            }}
          >
            <Text style={styles.bannerBtn}>Enable</Text>
          </Pressable>
        </View>
      ) : null}
      {loading && !counts ? (
        <ActivityIndicator color={colors.playportOrange} style={{ marginTop: spacing.xxl }} />
      ) : (
        <View style={styles.grid}>
          {cards.map((c) => (
            <Pressable key={c.label} style={styles.statCard} onPress={() => router.push(c.href as never)}>
              <Text style={styles.statValue}>{c.value}</Text>
              <Text style={styles.statLabel}>{c.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  unreadChip: {
    backgroundColor: colors.badgeRed,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  unreadChipText: {
    color: colors.white,
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
  },
  refresh: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  refreshText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.primaryText,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 140,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 6,
  },
  statValue: {
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
    color: colors.primaryText,
  },
  statLabel: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
  },
  alert: {
    backgroundColor: colors.orangeTint,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.playportOrange,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  alertRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  alertBody: { flex: 1, gap: 4 },
  alertTitle: {
    fontFamily: fonts.heading,
    fontSize: typeScale.body,
    color: colors.primaryText,
  },
  alertText: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  alertMeta: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    color: colors.mutedText,
  },
  alertDismiss: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
  },
  warn: {
    backgroundColor: colors.orangeTint,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.playportOrange,
    padding: spacing.lg,
    gap: 6,
  },
  warnTitle: {
    fontFamily: fonts.bodyMedium,
    color: colors.playportOrange,
    fontSize: typeScale.body,
  },
  warnBody: {
    fontFamily: fonts.body,
    color: colors.secondaryText,
    fontSize: typeScale.small,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  bannerText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  bannerBtn: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
  },
});

