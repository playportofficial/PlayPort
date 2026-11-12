import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AuthLoadingScreen } from '@/components/auth/AuthLoadingScreen';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { BUSINESS } from '@/constants/legal';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { ensureLoggedIn } from '@/utils/authGate';
import { formatINR } from '@/utils/format';
import { formatFunctionsError } from '@/utils/functionsError';
import type { Order } from '@/types';

const REASONS = ['Changed plans', 'Found alternative', 'Delay', 'Other'] as const;

export default function CancelOrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding } = useResponsive();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const orders = useAppStore((s) => s.orders);
  const cancelOrder = useAppStore((s) => s.cancelOrder);
  const order = useMemo(() => orders.find((o) => o.id === id), [orders, id]);

  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [otherText, setOtherText] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authReady && !isAuthenticated) ensureLoggedIn(`/order/cancel/${id}`);
  }, [authReady, isAuthenticated, id]);

  if (!authReady) return <AuthLoadingScreen />;

  if (!isAuthenticated) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Cancel Order" onBack={() => router.back()} />
        <EmptyState
          title="Log in required"
          subtitle="Sign in to cancel this booking."
          actionLabel="Log in"
          onAction={() => ensureLoggedIn(`/order/cancel/${id}`)}
        />
      </Screen>
    );
  }

  if (!order) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Cancel Order" onBack={() => router.back()} />
        <EmptyState
          icon="close-circle-outline"
          title="Order not found"
          actionLabel="Back to orders"
          onAction={() => router.replace('/(tabs)/orders')}
        />
      </Screen>
    );
  }

  if (done || order.status === 'cancelled') {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Cancelled" onBack={() => router.replace('/(tabs)/orders')} />
        <View style={[styles.successWrap, { paddingHorizontal: horizontalPadding }]}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark-circle" size={48} color={colors.success} />
          </View>
          <Text style={styles.successTitle}>Order cancelled</Text>
          <Text style={styles.successBody}>
            {order.paymentStatus === 'cod'
              ? `#${order.id} is cancelled. Nothing was charged — there's nothing to refund.`
              : refundDoneBodyFor(order)}
          </Text>
          <Button title="Go to orders" fullWidth onPress={() => router.replace('/(tabs)/orders')} />
        </View>
      </Screen>
    );
  }

  if (order.riderId) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Cancel Order" subtitle={`#${order.id}`} onBack={() => router.back()} />
        <EmptyState
          icon="bicycle-outline"
          title="Delivery partner assigned"
          subtitle={`${order.riderName ?? 'Your rider'} has already accepted this run, so #${order.id} can't be cancelled in the app. WhatsApp us at ${BUSINESS.phone} to cancel or reschedule — it's free until we dispatch; after that a ₹${BUSINESS.failedDeliveryFee} failed-delivery fee may apply.`}
          actionLabel="Contact support"
          onAction={() => router.push('/profile/help')}
        />
      </Screen>
    );
  }

  const canConfirm =
    reason != null && (reason !== 'Other' || otherText.trim().length > 0);

  const onConfirm = async () => {
    if (!canConfirm || !id || busy) return;
    const finalReason = reason === 'Other' ? otherText.trim() : reason!;
    setBusy(true);
    setError(null);
    try {
      await cancelOrder(id, finalReason);
      setDone(true);
    } catch (e) {
      setError(formatFunctionsError(e));
    } finally {
      setBusy(false);
    }
  };

  const first = order.items[0];

  return (
    <Screen showHeader={false} narrow>
      <ScreenHeader title="Cancel Order" subtitle={`#${order.id}`} onBack={() => router.back()} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
      >
        <Card style={styles.summary}>
          <View style={styles.summaryTop}>
            <StatusBadge status={order.status} />
            <Text style={styles.total}>{formatINR(order.total)}</Text>
          </View>
          <View style={styles.row}>
            <Image source={{ uri: first.image }} style={styles.image} contentFit="cover" />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.name} numberOfLines={2}>
                {first.name}
                {order.items.length > 1 ? ` +${order.items.length - 1}` : ''}
              </Text>
              <Text style={styles.meta}>{first.durationLabel}</Text>
              <Text style={styles.meta}>{order.addressLabel}</Text>
            </View>
          </View>
        </Card>

        <Text style={styles.sectionTitle}>Why are you cancelling?</Text>
        <View style={styles.chips}>
          {REASONS.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="button"
              onPress={() => setReason(r)}
              style={[styles.chip, reason === r && styles.chipActive]}
            >
              <Text style={[styles.chipText, reason === r && styles.chipTextActive]}>{r}</Text>
            </Pressable>
          ))}
        </View>

        {reason === 'Other' ? (
          <TextInput
            value={otherText}
            onChangeText={setOtherText}
            placeholder="Tell us more…"
            placeholderTextColor={colors.mutedText}
            multiline
            style={styles.input}
          />
        ) : null}

        <Card style={styles.refund}>
          <View style={styles.refundHead}>
            <Ionicons name="wallet-outline" size={18} color={colors.playportOrange} />
            <Text style={styles.refundTitle}>Refund info</Text>
          </View>
          <Text style={styles.refundBody}>
            {refundCardBodyFor(order)}
          </Text>
          <Text
            style={styles.refundLink}
            accessibilityRole="link"
            onPress={() => router.push('/legal/refunds' as never)}
          >
            Read the Refund & Cancellation Policy
          </Text>
        </Card>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Button
          title={busy ? 'Cancelling…' : 'Confirm cancellation'}
          variant="danger"
          fullWidth
          disabled={!canConfirm || busy}
          onPress={() => void onConfirm()}
        />
        <Button title="Keep my order" variant="ghost" fullWidth onPress={() => router.back()} />
      </ScrollView>
    </Screen>
  );
}

function refundCardBodyFor(order: Order): string {
  if (order.paymentStatus === 'cod') {
    return 'Free cancellation before dispatch. Nothing was charged, so there is nothing to refund.';
  }
  return `Free cancellation before dispatch. The full ${formatINR(order.total)} goes back to your original payment method within 7 working days; your bank or payment provider may take a few extra days to show it.`;
}

function refundDoneBodyFor(order: Order): string {
  if (order.paymentStatus === 'cod') {
    return `#${order.id} is cancelled. Nothing was charged — there's nothing to refund.`;
  }
  if (order.refund?.status === 'processed') {
    if (order.refund.providerRefundId) {
      return `#${order.id} is cancelled. Refund of ${formatINR(order.refund.amount ?? order.total)} was processed via Razorpay (refund ${order.refund.providerRefundId}) and is on its way back to ${order.paymentMethodLabel}. It may take a few working days to show, and sometimes a little longer depending on your bank or payment provider.`;
    }
    return `#${order.id} is cancelled. Refund of ${formatINR(order.refund.amount ?? order.total)} has been processed and is on its way back to ${order.paymentMethodLabel}. It may take a few working days to show, and sometimes a little longer depending on your bank or payment provider.`;
  }
  if (order.refund?.status === 'pending') {
    if (order.refund.providerRefundId) {
      return `#${order.id} is cancelled. Refund of ${formatINR(order.refund.amount ?? order.total)} has been requested and is in progress. We’ll update this order when it’s confirmed. Expect it within 7 working days, and sometimes a little longer depending on your bank or payment provider.`;
    }
    return `#${order.id} is cancelled. Refund of ${formatINR(order.refund.amount ?? order.total)} has been recorded for the PlayPort team to process manually, and will be sent back to ${order.paymentMethodLabel} within 7 working days. Your bank or payment provider may take a few extra days to show it.`;
  }
  if (order.refund?.status === 'failed') {
    return `#${order.id} is cancelled, but the automatic refund could not be completed: ${order.refund.error ?? 'unknown error'}. Please contact PlayPort on WhatsApp so we can sort it out.`;
  }
  // Fallback for a paid order that transitioned to cancelled/refunded before we
  // had a refund record (legacy data, or the server wrote the status first).
  return `#${order.id} is cancelled. The full ${formatINR(order.total)} goes back to ${order.paymentMethodLabel} within 7 working days; your bank or payment provider may take a few extra days to show it.`;
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxxl, gap: spacing.lg, paddingTop: spacing.sm },
  summary: { gap: spacing.md },
  summaryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { color: colors.primaryText, fontFamily: fonts.monoMedium, fontSize: 16 },
  row: { flexDirection: 'row', gap: 12 },
  image: { width: 64, height: 64, borderRadius: radii.sm },
  name: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: 15 },
  meta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 12 },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceRaised,
  },
  chipActive: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  chipText: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: 13 },
  chipTextActive: { color: colors.playportOrange },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.md,
    padding: spacing.md,
    color: colors.primaryText,
    fontFamily: fonts.body,
    fontSize: 15,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  refund: { gap: spacing.sm },
  refundHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  refundTitle: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 15 },
  refundLink: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    marginTop: 6,
    textDecorationLine: 'underline',
  },
  refundBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  successWrap: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  successIcon: { alignItems: 'center' },
  successTitle: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 24,
    textAlign: 'center',
  },
  successBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
