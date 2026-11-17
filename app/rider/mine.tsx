import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useRiderStore } from '@/store/riderStore';
import { rentalWindow, riderContactLine, riderStatusLabel } from '@/utils/format';
import { deliverySlot, formatSlotStatus } from '@/utils/serviceHours';

export default function RiderMineScreen() {
  const { horizontalPadding } = useResponsive();
  const mine = useRiderStore((s) => s.mine);
  const active = mine.filter((o) =>
    ['out_for_delivery', 'delivered', 'active', 'returning'].includes(o.status)
  );
  const done = mine.filter((o) => ['completed', 'cancelled', 'refunded'].includes(o.status));

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
    >
      <Text style={styles.title}>My runs</Text>
      <Text style={styles.sub}>
        {active.length} active · {done.length} closed
      </Text>

      {mine.length === 0 ? (
        <Text style={styles.empty}>Accept a job from Available to start a run.</Text>
      ) : (
        mine.map((order) => {
          const rental = rentalWindow(order);
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
              <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
              {contact ? <Text style={styles.contact}>{contact}</Text> : null}
              {order.addressInstructions ? (
                <Text style={styles.meta}>{order.addressInstructions}</Text>
              ) : null}
              {rental ? (
                <Text
                  style={[
                    styles.meta,
                    !rental.started && slot?.state !== 'upcoming' && styles.metaWarn,
                  ]}
                >
                  {rental.started
                    ? `Rental running${rental.hours ? ` · ${rental.hours}h` : ''}${rental.endLabel ? ` · returns ${rental.endLabel}` : ''}`
                    : slot
                      ? formatSlotStatus(slot)
                      : `Booked ${rental.range}${rental.hours ? ` · ${rental.hours}h` : ''} · timer starts at handover`}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                ₹{order.total} · {order.items?.[0]?.name ?? 'Kit'}
                {order.items && order.items.length > 1 ? ` +${order.items.length - 1}` : ''}
              </Text>
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
  metaWarn: { color: colors.danger },
  empty: { fontFamily: fonts.body, color: colors.mutedText, marginTop: spacing.xl },
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
  meta: { fontFamily: fonts.body, fontSize: typeScale.small, color: colors.secondaryText },
  contact: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    color: colors.primaryText,
  },
});
