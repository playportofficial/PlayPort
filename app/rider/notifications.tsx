import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { enableWebPush, type WebPushState } from '@/lib/fcm';
import { useAppStore } from '@/store/appStore';

const PUSH_COPY: Record<Exclude<WebPushState, 'granted'>, string> = {
  'no-key': 'Push is not configured yet — ops must add the Firebase web push key. Alerts still appear below.',
  blocked:
    'This browser is blocking notifications. Allow notifications for playport.fun in the address-bar settings.',
  unsupported: 'Push is unavailable in this browser. Alerts still appear below whenever the tab is open.',
  error: 'Could not register this device. Reopen the app and try again, or tell ops.',
};

export default function RiderAlertsScreen() {
  const { horizontalPadding } = useResponsive();
  const notifications = useAppStore((s) => s.notifications);
  const markNotificationRead = useAppStore((s) => s.markNotificationRead);
  const markAllNotificationsRead = useAppStore((s) => s.markAllNotificationsRead);
  const [pushState, setPushState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') setPushState('granted');
    else if (Notification.permission === 'denied') setPushState('blocked');
  }, []);

  const turnOnPush = () => {
    setBusy(true);
    void enableWebPush()
      .then(setPushState)
      .finally(() => setBusy(false));
  };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
    >
      <View style={styles.headRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Alerts</Text>
          <Text style={styles.sub}>
            {unread ? `${unread} unread` : 'All caught up'} · new runs, assignments, cancellations
          </Text>
        </View>
        {unread ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={markAllNotificationsRead}>
            <Text style={styles.markAll}>Mark all</Text>
          </Pressable>
        ) : null}
      </View>

      {pushState && pushState !== 'granted' ? (
        <View style={styles.pushCard}>
          <Text style={styles.pushTitle}>Push notifications are off</Text>
          <Text style={styles.pushBody}>{PUSH_COPY[pushState]}</Text>
          {pushState === 'blocked' || pushState === 'unsupported' || pushState === 'no-key' ? null : (
            <Pressable
              accessibilityRole="button"
              style={[styles.pushBtn, busy && styles.pushBtnBusy]}
              disabled={busy}
              onPress={turnOnPush}
            >
              <Text style={styles.pushBtnText}>{busy ? 'Enabling…' : 'Turn on push'}</Text>
            </Pressable>
          )}
          {pushState === 'blocked' && Platform.OS === 'web' ? (
            <Pressable accessibilityRole="button" style={styles.pushBtn} onPress={turnOnPush}>
              <Text style={styles.pushBtnText}>Re-check permission</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {notifications.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No alerts yet</Text>
          <Text style={styles.emptySub}>
            Every run you are offered, every run ops assigns to you, and every cancellation lands
            here.
          </Text>
        </View>
      ) : (
        notifications.map((n) => (
          <Pressable
            key={n.id}
            accessibilityRole="button"
            onPress={() => {
              markNotificationRead(n.id);
              if (n.orderId) router.push(`/rider/order/${n.orderId}` as never);
            }}
          >
            <View style={[styles.card, !n.read && styles.cardUnread]}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>{n.title}</Text>
                {!n.read ? <View style={styles.dot} /> : null}
              </View>
              <Text style={styles.cardBody}>{n.body}</Text>
              <Text style={styles.cardTime}>{n.timeLabel}</Text>
            </View>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  scroll: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.sm },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: {
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
    color: colors.primaryText,
  },
  sub: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    marginTop: 4,
  },
  markAll: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.playportOrange,
    paddingTop: 6,
  },
  pushCard: {
    backgroundColor: colors.orangeTint,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 6,
    marginTop: spacing.sm,
  },
  pushTitle: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.primaryText,
  },
  pushBody: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  pushBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: colors.playportOrange,
  },
  pushBtnBusy: { opacity: 0.6 },
  pushBtnText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.white,
  },
  empty: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 6,
    marginTop: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.primaryText,
  },
  emptySub: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  cardUnread: { borderColor: colors.playportOrange },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.primaryText,
    flex: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.playportOrange },
  cardBody: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  cardTime: { fontFamily: fonts.mono, fontSize: 11, color: colors.mutedText, marginTop: 2 },
});
