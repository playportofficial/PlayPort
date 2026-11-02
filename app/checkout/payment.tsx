import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AuthLoadingScreen } from '@/components/auth/AuthLoadingScreen';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { StickyBottomBar, useStickyBarPadding } from '@/components/layout/StickyBottomBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { TermsAcceptance } from '@/components/legal/TermsAcceptance';
import { OrderingPausedBanner } from '@/components/layout/OrderingPausedBanner';
import { useCatalogStore } from '@/store/catalogStore';
import { LEGAL_VERSION } from '@/constants/legal';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { deliveryNoteFor, useDeliveryQuote } from '@/hooks/useDeliveryQuote';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore, useCartTotals } from '@/store/appStore';
import { ensureLoggedIn } from '@/utils/authGate';
import { formatINR } from '@/utils/format';
import { isValidScheduledStart } from '@/utils/serviceHours';
import type { PaymentMethodType } from '@/types';

const PAY_ICONS: Record<PaymentMethodType, keyof typeof Ionicons.glyphMap> = {
  online: 'card-outline',
  upi: 'phone-portrait-outline',
  card: 'card-outline',
  netbanking: 'business-outline',
  cod: 'cash-outline',
};

export default function PaymentScreen() {
  const { horizontalPadding } = useResponsive();
  const stickyPad = useStickyBarPadding();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const cart = useAppStore((s) => s.cart);
  const paymentMethods = useAppStore((s) => s.paymentMethods);
  const selectedPaymentMethodId = useAppStore((s) => s.selectedPaymentMethodId);
  const selectPaymentMethod = useAppStore((s) => s.selectPaymentMethod);
  const placeOrder = useAppStore((s) => s.placeOrder);
  const paymentError = useAppStore((s) => s.paymentError);
  const clearPaymentError = useAppStore((s) => s.clearPaymentError);
  const pendingOrderId = useAppStore((s) => s.pendingOrderId);
  const totals = useCartTotals();
  const delivery = useDeliveryQuote();
  const [paying, setPaying] = useState(false);
  const [displayTotal, setDisplayTotal] = useState(totals.total);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const orderingPaused = useCatalogStore((s) => s.orderingPaused);
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const scheduledOrder = isValidScheduledStart(scheduledStartAt, new Date());

  useEffect(() => {
    if (!scheduledOrder) return;
    const current = paymentMethods.find((m) => m.id === selectedPaymentMethodId);
    if (current?.type === 'cod') {
      const online = paymentMethods.find((m) => m.type !== 'cod');
      if (online) selectPaymentMethod(online.id);
    }
  }, [scheduledOrder, paymentMethods, selectedPaymentMethodId, selectPaymentMethod]);

  useEffect(() => {
    if (authReady && !isAuthenticated) {
      ensureLoggedIn('/checkout/payment');
    }
  }, [authReady, isAuthenticated]);

  const pay = async (fail = false) => {
    if (!ensureLoggedIn('/checkout/payment')) return;
    setPaying(true);
    setDisplayTotal(totals.total);
    clearPaymentError();
    try {
      const result = await placeOrder(fail, { termsVersion: termsAccepted ? LEGAL_VERSION : undefined });
      if (result.ok && result.orderId) {
        router.replace({ pathname: '/checkout/confirmation', params: { id: result.orderId } });
        return;
      }
    } finally {
      setPaying(false);
    }
  };

  if (!authReady) return <AuthLoadingScreen />;

  if (!isAuthenticated) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Payment" onBack={() => router.back()} />
        <EmptyState
          title="Log in to pay"
          subtitle="Sign in to complete your rental payment."
          actionLabel="Log in"
          onAction={() => ensureLoggedIn('/checkout/payment')}
        />
      </Screen>
    );
  }

  if (!cart.length && !paymentError && !paying && !pendingOrderId) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Payment" onBack={() => router.back()} />
        <EmptyState
          title="Cart is empty"
          subtitle="Add gear before paying."
          actionLabel="Explore"
          onAction={() => router.replace('/(tabs)')}
        />
      </Screen>
    );
  }

  const amount = (paying ? displayTotal : totals.total) || 0;
  const termsOk = termsAccepted;
  const deliveryReady = Boolean(pendingOrderId) || (delivery.status === 'ready' && Boolean(delivery.quote));
  const deliveryLine =
    delivery.status === 'ready' && delivery.quote
      ? delivery.quote.fee > 0
        ? `Includes ${formatINR(delivery.quote.fee)} delivery (${delivery.quote.km} km)`
        : `Free delivery (${delivery.quote.km} km from hub)`
      : deliveryNoteFor(delivery.status);
  const methods = scheduledOrder ? paymentMethods.filter((m) => m.type !== 'cod') : paymentMethods;
  const selectedMethod = methods.find((m) => m.id === selectedPaymentMethodId);
  const isCod = selectedMethod?.type === 'cod';

  return (
    <Screen showHeader={false} edges={['top']} narrow>
      <ScreenHeader
        title="Checkout"
        subtitle="Step 2 of 2 · Payment"
        onBack={() => router.back()}
        right={
          <View style={styles.stepRight}>
            <View style={styles.stepDot} />
            <Text style={styles.stepMono}>PAYMENT</Text>
          </View>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: horizontalPadding, paddingBottom: stickyPad },
        ]}
      >
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Payment Method</Text>
          <Text style={styles.secure}>100% SECURE</Text>
        </View>

        <View style={styles.methods}>
          {scheduledOrder && paymentMethods.some((m) => m.type === 'cod') ? (
            <Text style={styles.summaryNote}>Cash on delivery is only for ASAP orders — scheduled orders are paid online.</Text>
          ) : null}
          {methods.map((method) => {
            const selected = method.id === selectedPaymentMethodId;
            return (
              <Pressable
                key={method.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => selectPaymentMethod(method.id)}
                style={[styles.method, selected && styles.methodSelected]}
              >
                <View style={[styles.radio, selected && styles.radioOn]}>
                  {selected ? <View style={styles.radioDot} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.methodTitleRow}>
                    <Text style={styles.methodLabel}>{method.label}</Text>
                    {method.recommended ? (
                      <Badge label="RECOMMENDED" color={colors.white} backgroundColor={colors.playportOrange} />
                    ) : null}
                  </View>
                  <Text style={styles.methodSub}>{method.subtitle}</Text>
                  {method.last4 ? (
                    <Text style={styles.methodMeta}>
                      {method.brand} ···· {method.last4}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name={PAY_ICONS[method.type]} size={20} color={colors.secondaryText} />
              </Pressable>
            );
          })}
        </View>

        <View style={styles.summary}>
          <Text style={styles.summaryTitle}>Order total</Text>
          <Text style={styles.summaryTotal}>{formatINR(amount)}</Text>
          <Text style={styles.summaryNote}>{deliveryLine}</Text>
          <Text style={styles.summaryNote}>
            {isCod
              ? 'Pay the rider in cash or UPI at handover'
              : 'Pay only what you see'}
          </Text>
        </View>

        <OrderingPausedBanner style={{ marginBottom: 0 }} />
        <TermsAcceptance accepted={termsAccepted} onChange={setTermsAccepted} />

        {paymentError ? (
          <ErrorState
            title="Payment failed"
            subtitle={paymentError}
            actionLabel="Retry payment"
            onAction={() => pay(false)}
          />
        ) : null}
      </ScrollView>

      <StickyBottomBar style={styles.stickyBar}>
        <View style={styles.stickyCol}>
          <Button
            title={
              paying
                ? 'Processing…'
                : isCod
                  ? `Place order · ${formatINR(amount)}`
                  : `Pay ${formatINR(amount)}`
            }
            icon={
              paying ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Ionicons name={isCod ? 'cash-outline' : 'flash'} size={16} color={colors.white} />
              )
            }
            fullWidth
            disabled={paying || !cart.length || !deliveryReady || !termsOk || orderingPaused}
            onPress={() => pay(false)}
          />
          {!termsOk ? (
            <Text style={styles.termsHint}>Tick the box above to accept the Terms and continue.</Text>
          ) : null}
          {__DEV__ ? (
            <Button
              title="Simulate failure"
              variant="ghost"
              size="sm"
              disabled={paying || !cart.length}
              onPress={() => pay(true)}
              style={{ marginTop: 8 }}
            />
          ) : null}
        </View>
      </StickyBottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: spacing.lg, paddingTop: spacing.sm },
  stepRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepMono: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.6,
  },
  stepDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.playportOrange },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  secure: {
    color: colors.success,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.6,
  },
  methods: { gap: 10 },
  method: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
  },
  methodSelected: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.mutedText,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioOn: { borderColor: colors.playportOrange },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.playportOrange },
  methodTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  methodLabel: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.bodyLg },
  methodSub: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    marginTop: 4,
    lineHeight: 17,
  },
  methodMeta: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    marginTop: 6,
  },
  summary: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 4,
  },
  summaryTitle: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body },
  summaryTotal: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.display },
  summaryNote: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.small },
  stickyBar: { flexDirection: 'column', alignItems: 'stretch' },
  stickyCol: { width: '100%' },
  termsHint: {
    color: colors.mutedText,
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    textAlign: 'center',
    marginTop: 6,
  },
});
