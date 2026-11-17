import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { colors, fonts, radii, shadows, spacing, typeScale } from '@/constants/theme';
import { useExitToHomeOnBack } from '@/hooks/useExitToHomeOnBack';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { useNow } from '@/hooks/useNow';
import { formatINR, formatReturnLabel } from '@/utils/format';
import { isEnRoute, locationAgeLabel, remainingEtaMinutes } from '@/utils/liveEta';
import { goHome } from '@/utils/navigation';

const STEPS = [
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'dispatch', label: 'On the way' },
  { id: 'setup', label: 'Delivered' },
] as const;

const NEXT_STEPS = [
  {
    title: 'Rider prepares the kit',
    body: 'Someone from your hub accepts the order and gets the kit ready.',
  },
  {
    title: 'Live arrival time',
    body: 'Once they leave, tracking shows minutes and distance from their location.',
  },
  {
    title: 'Handover code',
    body: 'Read the 4-digit code to your rider so they can mark the kit delivered.',
  },
  {
    title: 'Pickup at the end of your slot',
    body: 'Leave the kit set up. The rider collects it when the rental ends.',
  },
];

function confirmationStep(status?: string): number {
  switch (status) {
    case 'preparing':
      return 1;
    case 'out_for_delivery':
      return 2;
    case 'delivered':
    case 'active':
    case 'returning':
    case 'completed':
      return 3;
    default:
      return 0;
  }
}

export default function ConfirmationScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { horizontalPadding } = useResponsive();
  const orders = useAppStore((s) => s.orders);
  const lastOrderId = useAppStore((s) => s.lastOrderId);
  const orderId = (typeof id === 'string' && id) || lastOrderId || orders[0]?.id;
  const order = orders.find((o) => o.id === orderId);
  const enRoute = isEnRoute(order?.status);
  const now = useNow(enRoute);

  // Browser Back must exit the paid flow — never revive payment / continue-pay.
  useExitToHomeOnBack(true);

  if (!order) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Confirmation" onBack={goHome} />
        <EmptyState
          title="Order not found"
          subtitle="We couldn’t load this confirmation."
          actionLabel="Go Home"
          onAction={goHome}
        />
      </Screen>
    );
  }

  const liveMinutes = remainingEtaMinutes(order, now);
  const liveAge = locationAgeLabel(order.riderLocationUpdatedAt, now);
  const activeStepIndex = confirmationStep(order.status);
  const paidVia =
    order.paymentProvider === 'demo' ||
    !order.paymentMethodLabel ||
    order.paymentMethodLabel === 'Demo checkout'
      ? ''
      : order.paymentMethodLabel;

  return (
    <Screen showHeader={false} edges={['top']} narrow>
      <ScreenHeader title="Order confirmed" onBack={goHome} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
      >
        <View style={styles.heroCard}>
          <View style={styles.heroIcon}>
            <Ionicons name="checkmark" size={28} color={colors.white} />
          </View>
          <Text style={styles.heroTitle}>Order confirmed</Text>
          <Text style={styles.heroSub}>
            {order.paymentStatus === 'cod'
              ? 'A rider from your hub will bring the kit to your address. Pay in cash or UPI at handover.'
              : order.paymentStatus === 'paid'
                ? 'A rider from your hub will bring the kit to your address.'
                : 'Payment is not finished yet. The booking is held until it clears.'}
          </Text>
          <View style={styles.orderPill}>
            <Text style={styles.orderPillText}>
              <Text style={styles.orderId}>#{order.id}</Text>
              {order.paymentStatus === 'paid'
                ? ' · Paid '
                : order.paymentStatus === 'cod'
                  ? ' · Pay on delivery '
                  : ' · Total '}
              {formatINR(order.total)}
              {paidVia ? ` via ${paidVia}` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.progressCard}>
          <View style={styles.etaRow}>
            <Ionicons name="time-outline" size={16} color={colors.secondaryText} />
            <Text style={styles.etaLabel}>ESTIMATED DROPOFF</Text>
            <Text style={styles.etaTime}>
              {enRoute && liveMinutes != null
                ? `${liveMinutes} min`
                : enRoute
                  ? 'Getting live location…'
                  : 'Starts when a rider is on the way'}
            </Text>
            {liveAge ? (
              <View style={styles.etaPill}>
                <Text style={styles.etaPillText}>{liveAge}</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.stepper}>
            {STEPS.map((step, index) => {
              const done = index < activeStepIndex;
              const active = index === activeStepIndex;
              const lineDone = index < activeStepIndex;
              return (
                <View key={step.id} style={styles.stepItem}>
                  <View style={styles.stepDotRow}>
                    <View
                      style={[
                        styles.stepConnector,
                        index === 0 && styles.stepConnectorHidden,
                        lineDone && index > 0 && styles.stepConnectorActive,
                      ]}
                    />
                    <View
                      style={[
                        styles.stepDot,
                        (done || active) && styles.stepDotActive,
                        done && styles.stepDotDone,
                      ]}
                    >
                      {done ? (
                        <Ionicons name="checkmark" size={12} color={colors.white} />
                      ) : active ? (
                        <View style={styles.activeInner} />
                      ) : null}
                    </View>
                    <View
                      style={[
                        styles.stepConnector,
                        index === STEPS.length - 1 && styles.stepConnectorHidden,
                        index < activeStepIndex && styles.stepConnectorActive,
                      ]}
                    />
                  </View>
                  <Text style={[styles.stepLabel, (done || active) && styles.stepLabelActive]}>
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>

          <View style={styles.addressRow}>
            <Ionicons name="location-outline" size={16} color={colors.playportOrange} />
            <Text style={styles.addressText}>{order.addressFull}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {order.items.length} Setup{order.items.length === 1 ? '' : 's'} Reserved
            </Text>
            <Text style={styles.monoLabel}>YOUR KIT</Text>
          </View>
          <View style={styles.itemList}>
            {order.items.map((item, index) => (
              <View key={`${item.name}-${index}`} style={styles.itemCard}>
                <Image source={{ uri: item.image }} style={styles.itemImage} contentFit="cover" />
                <View style={{ flex: 1 }}>
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.itemPrice}>{formatINR(item.price)}</Text>
                  </View>
                  <Text style={styles.itemMeta}>
                    {item.durationLabel} · {formatReturnLabel(order.endAt, item.returnLabel)}
                  </Text>
                  {item.extras?.map((extra) => (
                    <Text key={extra} style={styles.itemMeta}>
                      {extra}
                    </Text>
                  ))}
                  {item.badges?.length ? (
                    <Text style={styles.itemBadge}>{item.badges.join(' · ')}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </View>

        {order.deliveryOtp ? (
          <View style={styles.otpStrip}>
            <View style={styles.otpHead}>
              <Ionicons name="key-outline" size={15} color={colors.playportOrange} />
              <Text style={styles.otpLabel}>YOUR HANDOVER CODE</Text>
            </View>
            <Text style={styles.otpDigits}>
              {String(order.deliveryOtp).replace(/\D/g, '').split('').join(' ')}
            </Text>
            <Text style={styles.otpHint}>
              Show this to your rider when the kit arrives — it confirms delivery in the rider app.
              Also available on Track.
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.nextHeader}>
            <Ionicons name="shield-checkmark" size={18} color={colors.playportOrange} />
            <Text style={styles.sectionTitle}>What Happens Next</Text>
          </View>
          <View style={styles.nextList}>
            {NEXT_STEPS.map((step, index) => (
              <View key={step.title} style={styles.nextRow}>
                <View style={styles.nextNum}>
                  <Text style={styles.nextNumText}>{index + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.nextTitle}>{step.title}</Text>
                  <Text style={styles.nextBody}>{step.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <Button
          title="Track Order"
          fullWidth
          icon={<Ionicons name="navigate" size={16} color={colors.white} />}
          onPress={() => router.push(`/order/track/${order.id}`)}
        />
        <Button
          title="Continue Exploring"
          fullWidth
          variant="secondary"
          onPress={goHome}
        />

        <View style={styles.support}>
          <Ionicons name="headset-outline" size={16} color={colors.secondaryText} />
          <Text style={styles.supportText}>Questions? Contact support from your profile.</Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xxxl },
  heroCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.xl,
    alignItems: 'center',
    gap: 10,
    ...shadows.soft,
  },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.playportOrange,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
    ...shadows.glow,
  },
  heroTitle: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
    textAlign: 'center',
  },
  heroSub: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    textAlign: 'center',
    lineHeight: 20,
  },
  orderPill: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: 4,
  },
  orderPillText: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
  orderId: { color: colors.playportOrange, fontFamily: fonts.bodyMedium },
  progressCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 16,
  },
  etaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  etaLabel: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.5,
  },
  etaTime: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, flex: 1 },
  etaPill: {
    backgroundColor: colors.etaBg,
    borderRadius: radii.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  etaPillText: { color: colors.etaText, fontFamily: fonts.bodyMedium, fontSize: typeScale.caption },
  stepper: { flexDirection: 'row', alignItems: 'flex-start' },
  stepItem: { flex: 1, alignItems: 'center', gap: 8 },
  stepDotRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  stepConnector: {
    flex: 1,
    height: 2,
    backgroundColor: colors.borderSubtle,
  },
  stepConnectorActive: { backgroundColor: colors.playportOrange },
  stepConnectorHidden: { backgroundColor: 'transparent' },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotActive: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  stepDotDone: { backgroundColor: colors.playportOrange, borderColor: colors.playportOrange },
  activeInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.playportOrange },
  stepLabel: {
    color: colors.mutedText,
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    textAlign: 'center',
  },
  stepLabelActive: { color: colors.playportOrange, fontFamily: fonts.bodyMedium },
  otpStrip: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.orangeBorder,
    padding: spacing.lg,
    alignItems: 'center',
    gap: 6,
  },
  otpHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  otpLabel: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 1.2,
  },
  otpDigits: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.hero,
    letterSpacing: 10,
  },
  otpHint: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    textAlign: 'center',
    lineHeight: 17,
  },
  addressRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  addressText: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    flex: 1,
    lineHeight: 18,
  },
  section: { gap: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title },
  monoLabel: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.6,
  },
  itemList: { gap: 10 },
  itemCard: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
  },
  itemImage: { width: 56, height: 56, borderRadius: radii.sm },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  itemName: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, flex: 1 },
  itemPrice: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.body },
  itemMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, marginTop: 4 },
  itemBadge: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.caption, marginTop: 2 },
  nextHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nextList: { gap: 14 },
  nextRow: { flexDirection: 'row', gap: 12 },
  nextNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextNumText: { color: colors.playportOrange, fontFamily: fonts.bodyMedium, fontSize: typeScale.small },
  nextTitle: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  nextBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    marginTop: 4,
    lineHeight: 17,
  },
  support: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.sm,
  },
  supportText: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
});
