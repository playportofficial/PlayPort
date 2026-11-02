import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { StickyBottomBar, useStickyBarPadding } from '@/components/layout/StickyBottomBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import {
  callCreateExtensionPaymentOrder,
  callExtendBooking,
  callGetExtensionQuote,
  type ExtensionQuote,
} from '@/lib/functions';
import { openRazorpayCheckout } from '@/lib/razorpay';
import { useAppStore } from '@/store/appStore';
import { useFeelStore } from '@/store/feelStore';
import { formatINR, formatReturnLabel } from '@/utils/format';
import { formatFunctionsError } from '@/utils/functionsError';
import { rentalEndsInServiceHours } from '@/utils/serviceHours';

const OPTIONS = [1, 2, 3, 6, 12];

export function isExtendableStatus(status: string): boolean {
  return status === 'delivered' || status === 'active';
}

type OptionQuote = { quote?: ExtensionQuote; error?: string };

export default function ExtendOrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding } = useResponsive();
  const stickyPad = useStickyBarPadding();
  const order = useAppStore((s) => s.orders.find((o) => o.id === id));
  const applyOrderExtension = useAppStore((s) => s.applyOrderExtension);
  const user = useAppStore((s) => s.user);
  const showToast = useFeelStore((s) => s.showToast);

  const [hours, setHours] = useState(1);
  // Server quotes for every option, so each button shows exactly what will be charged.
  const [quotes, setQuotes] = useState<Record<number, OptionQuote>>({});
  const [quoting, setQuoting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const extendable =
    Boolean(order) && order!.paymentStatus === 'paid' && isExtendableStatus(order!.status);

  // Start on an option that doesn't end overnight (e.g. +1h from 11 PM is out).
  const endAt = order?.endAt;
  useEffect(() => {
    if (!endAt) return;
    const fitting = OPTIONS.filter((h) => rentalEndsInServiceHours(new Date(endAt), h));
    if (fitting.length && !fitting.includes(hours)) setHours(fitting[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endAt]);

  const fittingOptions = useMemo(
    () => (endAt ? OPTIONS.filter((h) => rentalEndsInServiceHours(new Date(endAt), h)) : OPTIONS),
    [endAt]
  );

  useEffect(() => {
    if (!order || !extendable) return;
    let cancelled = false;
    setQuoting(true);
    setQuotes({});
    void Promise.all(
      fittingOptions.map(async (h): Promise<[number, OptionQuote]> => {
        try {
          return [h, { quote: await callGetExtensionQuote(order.id, h) }];
        } catch (e) {
          return [h, { error: formatFunctionsError(e) }];
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setQuotes(Object.fromEntries(entries));
      setQuoting(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.endAt, extendable, fittingOptions]);

  const quote = quotes[hours]?.quote ?? null;
  const quoteError = quotes[hours]?.error ?? null;

  if (!order) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Extend session" onBack={() => router.back()} />
        <EmptyState
          title="Order not found"
          subtitle="This booking may have been removed."
          actionLabel="Back to orders"
          onAction={() => router.replace('/(tabs)/orders')}
        />
      </Screen>
    );
  }

  if (!extendable) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Extend session" onBack={() => router.back()} />
        <EmptyState
          icon="time-outline"
          title="Extension unavailable"
          subtitle="Only live, paid sessions (delivered or active) can be extended."
          actionLabel="View order"
          onAction={() => router.replace(`/order/${order.id}` as never)}
        />
      </Screen>
    );
  }

  const onExtend = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const paymentOrder = await callCreateExtensionPaymentOrder(order.id, hours);
      let res: { newEndAt: string; extensionTotal: number };
      if (paymentOrder.demo) {
        res = await callExtendBooking(order.id, hours, 'demo');
      } else {
        if (typeof window === 'undefined') {
          throw new Error('Online payment needs a browser — open PlayPort on the web.');
        }
        const paid = await openRazorpayCheckout({
          keyId: paymentOrder.keyId,
          amount: paymentOrder.amount,
          currency: paymentOrder.currency,
          razorpayOrderId: paymentOrder.razorpayOrderId,
          orderId: order.id,
          name: user?.name ?? '',
          phone: user?.phone ?? '',
          description: `Session extension · +${hours}h`,
        });
        res = await callExtendBooking(order.id, hours, 'razorpay', {
          razorpayOrderId: paid.razorpayOrderId,
          paymentId: paid.paymentId,
          signature: paid.signature,
        });
      }
      applyOrderExtension(order.id, {
        endAt: res.newEndAt,
        subtotal: order.subtotal + (quote?.subtotal ?? 0),
        taxes: order.taxes + (quote?.taxes ?? 0),
        total: order.total + (quote?.total ?? res.extensionTotal),
        items: order.items.map((it, idx) => ({
          ...it,
          price: it.price + (quote?.perItem[idx]?.price ?? 0),
          durationLabel: `${it.durationLabel} +${hours}h ext`,
          returnLabel: `Returns ${new Date(res.newEndAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        })),
      });
      showToast(`Extended by ${hours}h`);
      router.replace(`/order/${order.id}` as never);
    } catch (e) {
      setPayError(formatFunctionsError(e));
    } finally {
      setPaying(false);
    }
  };

  const total = quote?.total ?? 0;

  return (
    <Screen showHeader={false} edges={['top']} narrow>
      <ScreenHeader title="Extend session" subtitle={`#${order.id}`} onBack={() => router.back()} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: horizontalPadding, paddingBottom: stickyPad },
        ]}
      >
        <Card style={styles.current} elevated>
          <View style={styles.currentRow}>
            <Ionicons name="timer-outline" size={20} color={colors.playportOrange} />
            <View style={{ flex: 1 }}>
              <Text style={styles.currentLabel}>SESSION ENDS</Text>
              <Text style={styles.currentValue}>{formatReturnLabel(order.endAt, '—')}</Text>
              {order.extensions?.length ? (
                <Text style={styles.currentMeta}>
                  Extended {order.extensions.length}× · +{order.extensions.reduce((s, e) => s + e.additionalHours, 0)}h so far
                </Text>
              ) : null}
            </View>
          </View>
        </Card>

        <Text style={styles.sectionTitle}>Add more hours</Text>
        <Text style={styles.sectionSub}>
          Priced from the same hour packages · prices include any extra controllers
        </Text>
        <View style={styles.grid}>
          {OPTIONS.map((h) => {
            const fits = !order.endAt || rentalEndsInServiceHours(new Date(order.endAt), h);
            const active = fits && hours === h;
            return (
              <Pressable
                key={h}
                accessibilityRole="radio"
                accessibilityState={{ selected: active, disabled: !fits }}
                disabled={!fits}
                onPress={() => setHours(h)}
                style={[styles.opt, active && styles.optActive, !fits && styles.optOff]}
              >
                <Text style={[styles.optHours, active && styles.optHoursActive]}>+{h}h</Text>
                <Text style={[styles.optPrice, active && styles.optPriceActive]}>
                  {!fits
                    ? '—'
                    : quotes[h]?.quote
                      ? formatINR(quotes[h]!.quote!.total)
                      : quotes[h]?.error
                        ? 'Unavailable'
                        : '…'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {order.endAt && OPTIONS.some((h) => !rentalEndsInServiceHours(new Date(order.endAt!), h)) ? (
          <Text style={styles.sectionSub}>
            Greyed-out options would end after midnight, when we can’t pick up.
          </Text>
        ) : null}

        <Card style={styles.quote}>
          {quoting ? (
            <View style={styles.quoteRow}>
              <ActivityIndicator color={colors.playportOrange} />
              <Text style={styles.quoteMeta}>Checking availability…</Text>
            </View>
          ) : quoteError ? (
            <View style={styles.quoteCol}>
              <View style={styles.quoteRow}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
                <Text style={styles.quoteError}>{quoteError}</Text>
              </View>
              <Text style={styles.quoteMeta}>Try fewer hours — the kit may be booked next.</Text>
            </View>
          ) : quote ? (
            <View style={styles.quoteCol}>
              <View style={styles.quoteRow}>
                <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                <Text style={styles.quoteOk}>Available until {formatReturnLabel(quote.newEndAt)}</Text>
              </View>
              {quote.breakdown?.length
                ? quote.breakdown.map((line, i) => (
                    <View key={`${line.label}-${i}`} style={styles.perItem}>
                      <Text style={styles.perItemName}>{line.label}</Text>
                      <Text style={styles.perItemPrice}>{formatINR(line.amount)}</Text>
                    </View>
                  ))
                : quote.perItem.map((p) => (
                    <View key={p.name} style={styles.perItem}>
                      <Text style={styles.perItemName}>{p.name}</Text>
                      <Text style={styles.perItemPrice}>{formatINR(p.price)}</Text>
                    </View>
                  ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Extension total</Text>
                <Text style={styles.totalValue}>{formatINR(quote.total)}</Text>
              </View>
            </View>
          ) : null}
        </Card>

        {payError ? <Text style={styles.payError}>{payError}</Text> : null}
      </ScrollView>

      <StickyBottomBar>
        <View style={{ flex: 1 }}>
          <Text style={styles.stickyLabel}>Extension · +{hours}h</Text>
          <Text style={styles.stickyPrice}>{quoting ? 'Checking…' : quote ? formatINR(total) : '—'}</Text>
        </View>
        <Button
          title={paying ? 'Extending…' : `Pay & extend +${hours}h`}
          fullWidth={false}
          disabled={paying || quoting || !quote}
          icon={
            paying ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Ionicons name="add-circle-outline" size={18} color={colors.white} />
            )
          }
          onPress={() => void onExtend()}
          style={styles.extendBtn}
        />
      </StickyBottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: spacing.md, paddingTop: spacing.sm },
  current: { padding: spacing.lg },
  currentRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  currentLabel: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.8,
  },
  currentValue: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title, marginTop: 2 },
  currentMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, marginTop: 4 },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline, marginTop: spacing.sm },
  sectionSub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body, marginTop: -6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  opt: {
    flexGrow: 1,
    flexBasis: 100,
    minWidth: 96,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
    alignItems: 'center',
  },
  optActive: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint, borderWidth: 1.5 },
  optOff: { opacity: 0.35 },
  optHours: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 20 },
  optHoursActive: { color: colors.playportOrange },
  optPrice: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
  optPriceActive: { color: colors.playportOrange },
  quote: { padding: spacing.lg, gap: spacing.sm },
  quoteRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quoteCol: { gap: spacing.sm },
  quoteMeta: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body },
  quoteOk: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, flex: 1 },
  quoteError: { color: colors.danger, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, flex: 1 },
  perItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  perItemName: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, flex: 1 },
  perItemPrice: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  totalLabel: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  totalValue: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  payError: { color: colors.badgeRed, fontFamily: fonts.body, fontSize: typeScale.body, textAlign: 'center' },
  stickyLabel: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
  stickyPrice: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title, marginTop: 2 },
  extendBtn: { minWidth: 200 },
});
