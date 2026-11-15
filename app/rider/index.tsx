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

      {available.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No open deliveries</Text>
          <Text style={styles.emptySub}>
            Showing paid, unassigned orders for hub {rider?.hubId || '—'}. If a customer paid but
            nothing appears, check Admin → Riders that your hub matches the order hub
            (usually indiranagar).
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
          <Text style={styles.upcomingTitle}>Scheduled ahead · {upcoming.length}</Text>
          <Text style={styles.meta}>
            Booked for a later slot. Each one drops into Available 60 minutes before its
            delivery time, so you can plan your day now.
          </Text>
          {upcoming.map((order) => {
            const slot = deliverySlot(order);
            const contact = riderContactLine(order);
            return (
              <View key={order.id} style={styles.card}>
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
                {order.addressInstructions ? (
                  <Text style={styles.meta}>{order.addressInstructions}</Text>
                ) : null}
                <Text style={styles.meta}>
                  {order.items?.length ?? 0} items · ₹{order.total} · claimable later
                </Text>
              </View>
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
  link: { fontFamily: fonts.bodyMedium, color: colors.playportOrange, fontSize: typeScale.body },
});
