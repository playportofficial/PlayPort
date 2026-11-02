import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PriceBreakdown } from '@/components/cart/PriceBreakdown';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { useNow } from '@/hooks/useNow';
import { watchPickupCode } from '@/lib/firestore';
import { formatSlotTime } from '@/utils/serviceHours';
import { formatINR, formatReturnLabel } from '@/utils/format';
import { locationAgeLabel, remainingEtaMinutes } from '@/utils/liveEta';
import type { OrderStatus } from '@/types';

const TIMELINE = [
  { key: 'booked', label: 'Booked', icon: 'checkmark-circle' as const },
  { key: 'preparing', label: 'Preparing', icon: 'hardware-chip' as const },
  { key: 'on_way', label: 'On Way', icon: 'bicycle' as const },
  { key: 'in_use', label: 'In Use', icon: 'play' as const },
  { key: 'returned', label: 'Returned', icon: 'checkmark-done' as const },
] as const;

function timelineIndex(status: OrderStatus): number {
  switch (status) {
    case 'pending_payment':
      return -1;
    case 'confirmed':
      return 0;
    case 'preparing':
      return 1;
    case 'out_for_delivery':
      return 2;
    case 'delivered':
    case 'active':
      return 3;
    case 'returning':
    case 'completed':
      return 4;
    case 'cancelled':
    case 'refunded':
      return -1;
    default:
      return 0;
  }
}

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding } = useResponsive();
  const orders = useAppStore((s) => s.orders);
  const order = useMemo(() => orders.find((o) => o.id === id), [orders, id]);
  const trackable = order?.status === 'out_for_delivery' || order?.status === 'returning';
  const inUse = order?.status === 'delivered' || order?.status === 'active';
  const now = useNow(trackable || inUse);
  const [pickupCode, setPickupCode] = useState<string | null>(null);
  const showPickupCode = inUse || order?.status === 'returning';
  useEffect(() => {
    if (!id || !showPickupCode) return;
    return watchPickupCode(id, setPickupCode);
  }, [id, showPickupCode]);

  if (!order) {
    return (
      <Screen showHeader={false}>
        <ScreenHeader title="Order" onBack={() => router.back()} />
        <EmptyState
          icon="cube-outline"
          title="Order not found"
          subtitle="This booking may have been removed."
          actionLabel="Back to orders"
          onAction={() => router.replace('/(tabs)/orders')}
        />
      </Screen>
    );
  }

  const step = timelineIndex(order.status);
  const cancellable =
    !order.riderId &&
    (order.status === 'pending_payment' || order.status === 'confirmed' || order.status === 'preparing');
  const endMs = order.endAt ? new Date(order.endAt).getTime() : NaN;
  const minutesLeft = Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - now) / 60000)) : null;
  const timeLeft =
    minutesLeft == null
      ? ''
      : minutesLeft >= 60
        ? `${Math.floor(minutesLeft / 60)}h ${minutesLeft % 60}m left`
        : `${minutesLeft} min left`;
  const canExtend =
    (order.status === 'delivered' || order.status === 'active') && order.paymentStatus === 'paid';
  const liveMinutes = remainingEtaMinutes(order, now);
  const liveAge = locationAgeLabel(order.riderLocationUpdatedAt, now);
  const showRider = Boolean(order.riderName) && !['cancelled', 'refunded', 'pending_payment'].includes(order.status);

  return (
    <Screen showHeader={false}>
      <ScreenHeader
        title={`#${order.id}`}
        subtitle="Booking details"
        onBack={() => router.back()}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Help"
            onPress={() => router.push('/profile/help')}
            style={styles.helpBtn}
          >
            <Ionicons name="help-circle-outline" size={22} color={colors.primaryText} />
          </Pressable>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
      >
        <Card style={styles.statusCard}>
          <View style={styles.statusTop}>
            <StatusBadge status={order.status} />
            {trackable ? (
              <Text style={styles.eta}>
                {liveMinutes != null
                  ? `${order.status === 'returning' ? 'Pickup' : 'Arriving'} in ${liveMinutes} min`
                  : 'Getting live location…'}
                {liveAge ? ` · ${liveAge}` : ''}
              </Text>
            ) : null}
          </View>
          <Text style={styles.statusTitle}>
            {order.status === 'pending_payment'
              ? 'Finish payment to confirm'
              : order.status === 'out_for_delivery'
              ? 'Gear is on the way'
              : order.status === 'preparing'
                ? 'Your rider is preparing the kit'
                : order.status === 'confirmed'
                  ? 'Booking confirmed'
                  : orderStatusHeadline(order.status)}
          </Text>
          {inUse && order.endAt ? (
            <Text style={styles.endsLine}>
              Your time ends at {formatSlotTime(order.endAt)}
              {timeLeft ? ` · ${timeLeft}` : ''}
            </Text>
          ) : null}
          <Text style={styles.statusSub}>
            {order.addressLabel} · {order.addressFull}
          </Text>

          {step >= 0 ? (
            <View style={styles.timeline}>
              {TIMELINE.map((item, index) => {
                const done = index <= step;
                const current = index === step;
                return (
                  <View key={item.key} style={styles.timelineItem}>
                    <View
                      style={[
                        styles.timelineDot,
                        done && styles.timelineDotDone,
                        current && styles.timelineDotCurrent,
                      ]}
                    >
                      <Ionicons
                        name={item.icon}
                        size={14}
                        color={done ? colors.white : colors.mutedText}
                      />
                    </View>
                    <Text
                      style={[
                        styles.timelineLabel,
                        done && styles.timelineLabelDone,
                        current && styles.timelineLabelCurrent,
                      ]}
                    >
                      {item.label}
                    </Text>
                    {index < TIMELINE.length - 1 ? (
                      <View style={[styles.timelineLine, index < step && styles.timelineLineDone]} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${order.progressPercent}%` }]} />
          </View>
        </Card>

        {showPickupCode && pickupCode ? (
          <Card style={styles.codeCard}>
            <Text style={styles.codeLabel}>PICKUP CODE</Text>
            <Text style={styles.codeValue}>{pickupCode.split('').join(' ')}</Text>
            <Text style={styles.codeHint}>
              Give this code to your rider only when they collect the kit. It closes your rental.
            </Text>
          </Card>
        ) : null}

        <Text style={styles.sectionTitle}>Reserved Hardware</Text>
        <View style={styles.list}>
          {order.items.map((item, idx) => (
            <Card key={`${item.name}-${idx}`} style={styles.itemCard}>
              <View style={styles.itemRow}>
                <Image source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemMeta}>{item.durationLabel}</Text>
                  <Text style={styles.itemReturn}>
                    {formatReturnLabel(order.endAt, item.returnLabel)}
                  </Text>
                  {item.badges?.length ? (
                    <View style={styles.badgeRow}>
                      {item.badges.map((b) => (
                        <Badge key={b} label={b} />
                      ))}
                    </View>
                  ) : null}
                  {item.extras?.map((e) => (
                    <Text key={e} style={styles.extra}>
                      · {e}
                    </Text>
                  ))}
                </View>
                <Text style={styles.itemPrice}>{formatINR(item.price)}</Text>
              </View>
            </Card>
          ))}
        </View>

        {showRider ? (
          <Card style={styles.specialist}>
            <View style={styles.specialistAvatar}>
              <Ionicons name="person" size={22} color={colors.playportOrange} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.specialistLabel}>YOUR RIDER</Text>
              <Text style={styles.specialistName}>{order.riderName}</Text>
              <Text style={styles.specialistMeta}>
                {order.riderPhone ? order.riderPhone : 'Doorstep setup and pickup'}
              </Text>
            </View>
            {trackable ? <Badge label="ON THE WAY" /> : null}
          </Card>
        ) : order.setupIncluded &&
          !['completed', 'cancelled', 'refunded'].includes(order.status) ? (
          <Card style={styles.specialist}>
            <View style={styles.specialistAvatar}>
              <Ionicons name="person" size={22} color={colors.playportOrange} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.specialistLabel}>SETUP</Text>
              <Text style={styles.specialistName}>Waiting for a rider</Text>
              <Text style={styles.specialistMeta}>Someone from your hub accepts the run before delivery.</Text>
            </View>
          </Card>
        ) : null}

        <Card style={styles.protocol}>
          <View style={styles.protocolHead}>
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.playportOrange} />
            <Text style={styles.protocolTitle}>Collection Protocol</Text>
          </View>
          <Text style={styles.protocolBody}>
            Leave the kit set up at the end of your slot. Your rider collects it and checks the accessories.
          </Text>
        </Card>

        <Text style={styles.sectionTitle}>Payment</Text>
        <Card>
          <PriceBreakdown
            itemsTotal={order.subtotal}
            taxes={order.taxes}
            total={order.total}
            delivery={{ fee: order.deliveryFee ?? 0, km: order.deliveryKm }}
          />
          <Text style={styles.payMethod}>
            {order.paymentStatus === 'cod'
              ? `Pay ${formatINR(order.total)} on delivery`
              : order.paymentStatus === 'paid'
                ? order.paymentProvider === 'demo' ||
                  !order.paymentMethodLabel ||
                  order.paymentMethodLabel === 'Demo checkout'
                  ? 'Paid'
                  : `Paid via ${order.paymentMethodLabel}`
                : 'Payment not finished yet'}
          </Text>
        </Card>

        <View style={styles.actions}>
          {canExtend ? (
            <Button
              title={`Extend session · ends ${formatReturnLabel(order.endAt, '')}`}
              fullWidth
              icon={<Ionicons name="add-circle-outline" size={20} color={colors.white} />}
              onPress={() => router.push(`/order/extend/${order.id}` as never)}
              style={styles.extendBtn}
            />
          ) : null}
          {trackable ? (
            <Button
              title="Track Live Delivery"
              fullWidth
              icon={<Ionicons name="navigate" size={18} color={colors.white} />}
              onPress={() => router.push(`/order/track/${order.id}`)}
            />
          ) : null}
          <Button
            title="Contact support"
            variant="secondary"
            fullWidth
            icon={<Ionicons name="headset-outline" size={18} color={colors.primaryText} />}
            onPress={() => router.push('/profile/help')}
          />
          {cancellable ? (
            <Button
              title="Cancel Order"
              variant="danger"
              fullWidth
              onPress={() => router.push(`/order/cancel/${order.id}`)}
            />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function orderStatusHeadline(status: OrderStatus): string {
  switch (status) {
    case 'delivered':
      return 'Delivered & ready';
    case 'active':
      return 'Session in progress';
    case 'returning':
      return 'Return pickup scheduled';
    case 'completed':
      return 'Rental completed';
    case 'cancelled':
      return 'Order cancelled';
    case 'refunded':
      return 'Refund processed';
    case 'pending_payment':
      return 'Finish payment to confirm';
    default:
      return 'Order update';
  }
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxxl, gap: spacing.lg, paddingTop: spacing.sm },
  helpBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusCard: { gap: spacing.md, padding: spacing.xl },
  statusTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eta: { color: colors.secondaryText, fontFamily: fonts.mono, fontSize: 12 },
  statusTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 20 },
  statusSub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  endsLine: { color: colors.playportOrange, fontFamily: fonts.bodyMedium, fontSize: 15 },
  codeCard: { alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.playportOrange },
  codeLabel: { color: colors.mutedText, fontFamily: fonts.bodyMedium, fontSize: 12, letterSpacing: 1 },
  codeValue: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 32, letterSpacing: 6 },
  codeHint: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13, textAlign: 'center' },
  timeline: { flexDirection: 'row', marginTop: spacing.sm },
  timelineItem: { flex: 1, alignItems: 'center', position: 'relative' },
  timelineDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  timelineDotDone: { backgroundColor: colors.playportOrange },
  timelineDotCurrent: { borderWidth: 2, borderColor: colors.orangeSoft },
  timelineLabel: {
    color: colors.mutedText,
    fontFamily: fonts.mono,
    fontSize: 10,
    marginTop: 6,
    letterSpacing: 0.3,
  },
  timelineLabelDone: { color: colors.secondaryText },
  timelineLabelCurrent: { color: colors.playportOrange },
  timelineLine: {
    position: 'absolute',
    top: 14,
    left: '55%',
    right: '-45%',
    height: 2,
    backgroundColor: colors.borderSubtle,
  },
  timelineLineDone: { backgroundColor: colors.playportOrange },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.playportOrange, borderRadius: 4 },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 18 },
  list: { gap: spacing.md },
  itemCard: { gap: 0, padding: spacing.lg },
  itemRow: { flexDirection: 'row', gap: 12 },
  itemImage: {
    width: 72,
    height: 72,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
  },
  itemName: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: 15 },
  itemMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 12 },
  itemReturn: { color: colors.mutedText, fontFamily: fonts.body, fontSize: 11 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  extra: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 11 },
  itemPrice: { color: colors.primaryText, fontFamily: fonts.monoMedium, fontSize: 14 },
  specialist: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  specialistAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  specialistLabel: {
    color: colors.mutedText,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  specialistName: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 16 },
  specialistMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 12 },
  protocol: { gap: spacing.sm, padding: spacing.lg },
  protocolHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  protocolTitle: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 15 },
  protocolBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
  },
  payMethod: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 13,
    marginTop: spacing.md,
  },
  toast: {
    color: colors.success,
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    textAlign: 'center',
  },
  actions: { gap: spacing.sm },
  extendBtn: { minHeight: 56 },
});
