import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useRiderStore } from '@/store/riderStore';
import { riderContactLine, riderStatusLabel } from '@/utils/format';
import { deliverySlot, formatLate } from '@/utils/serviceHours';

export default function RiderAvailableScreen() {
  const { horizontalPadding } = useResponsive();
  const rider = useRiderStore((s) => s.rider);
  const available = useRiderStore((s) => s.available);
  const upcoming = useRiderStore((s) => s.upcoming);
  const error = useRiderStore((s) => s.error);
  const accept = useRiderStore((s) => s.accept);

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
    >
      <Text style={styles.title}>Available jobs</Text>
      <Text style={styles.sub}>
        {rider?.name} · hub {rider?.hubId || '—'} · {available.length} open
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {upcoming.length > 0 ? (
        <Pressable
          style={styles.prebookBanner}
          onPress={() => router.push('/rider/scheduled' as never)}
          accessibilityRole="button"
        >
          <Text style={styles.prebookTitle}>
            {upcoming.length} pre-booked run{upcoming.length === 1 ? '' : 's'} paid ahead
          </Text>
          <Text style={styles.prebookBody}>
            Not in Available yet — they open about an hour before the slot. Tap to see who, where and
            when.
          </Text>
        </Pressable>
      ) : null}

      {available.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No open deliveries</Text>
          <Text style={styles.emptySub}>
            Showing paid, unassigned orders for hub {rider?.hubId || '—'} that are claimable now. Paid
            future slots live under Pre-booked
            {upcoming.length ? ` (${upcoming.length})` : ''}.
          </Text>
        </View>
      ) : (
        available.map((order) => {
          const slot = deliverySlot(order);
          const contact = riderContactLine(order);
          return (
            <View key={order.id} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.cardTitle}>{order.id}</Text>
                <StatusBadge status={order.status} label={riderStatusLabel(order.status)} />
              </View>
              <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
              {contact ? <Text style={styles.contact}>{contact}</Text> : null}
              {order.addressInstructions ? (
                <Text style={styles.meta}>{order.addressInstructions}</Text>
              ) : null}
              {slot ? (
                <Text style={[styles.meta, slot.state !== 'upcoming' && styles.metaWarn]}>
                  {slot.state === 'upcoming'
                    ? `Delivery slot ${slot.window}${slot.hours ? ` · ${slot.hours}h` : ''} · clock starts at handover`
                    : slot.state === 'closed'
                      ? `Window closed ${formatLate(slot.overdueMinutes)} ago · ${slot.window}`
                      : `Delivery slot ${slot.startLabel} · ${formatLate(slot.lateMinutes)} late · clock starts at handover`}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                {order.items?.length ?? 0} items · ₹{order.total} · ETA {order.etaLabel}
              </Text>
              <View style={styles.actions}>
                <Button
                  title="Accept run"
                  size="sm"
                  onPress={() => {
                    void accept(order.id)
                      .then(() => router.push(`/rider/order/${order.id}` as never))
                      .catch((e) => {
                        if (typeof window !== 'undefined') {
                          window.alert(e instanceof Error ? e.message : 'Accept failed');
                        }
                      });
                  }}
                />
                <Pressable onPress={() => router.push(`/rider/order/${order.id}` as never)}>
                  <Text style={styles.link}>Details</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}

      {upcoming.length ? (
        <View style={styles.upcomingBlock}>
          <View style={styles.row}>
            <Text style={styles.upcomingTitle}>Pre-booked · {upcoming.length}</Text>
            <Pressable onPress={() => router.push('/rider/scheduled' as never)}>
              <Text style={styles.link}>See all</Text>
            </Pressable>
          </View>
          <Text style={styles.meta}>
            Already paid for a later slot. Full list (with numbers) is under Pre-booked — they move
            into Available about an hour before delivery.
          </Text>
          {upcoming.slice(0, 3).map((order) => {
            const slot = deliverySlot(order);
            const contact = riderContactLine(order);
            return (
              <Pressable
                key={order.id}
                style={styles.card}
                onPress={() => router.push(`/rider/order/${order.id}` as never)}
              >
                <View style={styles.row}>
                  <Text style={styles.cardTitle}>{order.id}</Text>
                  <StatusBadge status={order.status} label={riderStatusLabel(order.status)} />
                </View>
                {slot ? (
                  <Text style={styles.meta}>
                    Slot {slot.window}
                    {slot.hours ? ` · ${slot.hours}h` : ''}
                  </Text>
                ) : null}
                <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
                {contact ? <Text style={styles.contact}>{contact}</Text> : null}
                <Text style={styles.meta}>
                  ₹{order.total} · paid · tap for details
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  scroll: { paddingTop: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.md },
  title: { fontFamily: fonts.heading, fontSize: typeScale.display, color: colors.primaryText },
  sub: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.secondaryText },
  error: { fontFamily: fonts.body, color: colors.danger, fontSize: typeScale.body },
  empty: {
    marginTop: spacing.xl,
    padding: spacing.xl,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceRaised,
    gap: 6,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: typeScale.title, color: colors.primaryText },
  emptySub: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.secondaryText },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontFamily: fonts.heading, fontSize: typeScale.title, color: colors.primaryText },
  meta: { fontFamily: fonts.body, fontSize: typeScale.small, color: colors.secondaryText, lineHeight: 18 },
  contact: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.primaryText,
    lineHeight: 18,
  },
  metaWarn: { color: colors.danger },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 4 },
  upcomingBlock: { marginTop: spacing.xl, gap: spacing.sm },
  upcomingTitle: {
    fontFamily: fonts.heading,
    fontSize: typeScale.title,
    color: colors.primaryText,
  },
  prebookBanner: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.playportOrange,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: 4,
  },
  prebookTitle: {
    fontFamily: fonts.heading,
    fontSize: typeScale.title,
    color: colors.playportOrange,
  },
  prebookBody: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  link: { fontFamily: fonts.bodyMedium, color: colors.playportOrange, fontSize: typeScale.body },
});
