import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useRiderStore } from '@/store/riderStore';
import { riderContactLine, riderStatusLabel } from '@/utils/format';
import { deliverySlot, formatSlot } from '@/utils/serviceHours';

/**
 * Paid runs whose delivery slot is still ahead. Available stays empty for these
 * until ~60 minutes before the slot — this page is how ops/riders see who paid
 * and when to show up, without waiting for the claim window.
 */
export default function RiderScheduledScreen() {
  const { horizontalPadding } = useResponsive();
  const rider = useRiderStore((s) => s.rider);
  const upcoming = useRiderStore((s) => s.upcoming);
  const error = useRiderStore((s) => s.error);

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
    >
      <Text style={styles.title}>Pre-booked</Text>
      <Text style={styles.sub}>
        {rider?.name} · hub {rider?.hubId || '—'} · {upcoming.length} paid ahead
      </Text>
      <Text style={styles.hint}>
        These customers already paid. They move into Available about an hour before the slot — open
        Details any time for the number, address and kit.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {upcoming.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No pre-booked runs yet</Text>
          <Text style={styles.emptySub}>
            When someone pays for a later slot on hub {rider?.hubId || '—'}, it lands here with their
            contact and delivery time.
          </Text>
        </View>
      ) : (
        upcoming.map((order) => {
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
              <Text style={styles.slot}>
                {order.startAt ? formatSlot(order.startAt) : slot?.window || 'Scheduled'}
                {slot?.hours ? ` · ${slot.hours}h rental` : ''}
              </Text>
              <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
              {contact ? <Text style={styles.contact}>{contact}</Text> : null}
              {order.addressInstructions ? (
                <Text style={styles.meta}>Door notes: {order.addressInstructions}</Text>
              ) : null}
              <Text style={styles.meta}>
                {order.items?.map((i) => i.name).filter(Boolean).join(', ') || 'Kit'} · ₹{order.total} ·
                paid
              </Text>
              <Text style={styles.link}>Open details</Text>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  scroll: { paddingTop: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.md },
  title: { fontFamily: fonts.heading, fontSize: typeScale.display, color: colors.primaryText },
  sub: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.secondaryText },
  hint: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 18,
  },
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
  slot: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
    color: colors.playportOrange,
  },
  meta: { fontFamily: fonts.body, fontSize: typeScale.small, color: colors.secondaryText, lineHeight: 18 },
  contact: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.primaryText,
    lineHeight: 18,
  },
  link: {
    marginTop: 4,
    fontFamily: fonts.bodyMedium,
    color: colors.playportOrange,
    fontSize: typeScale.body,
  },
});
