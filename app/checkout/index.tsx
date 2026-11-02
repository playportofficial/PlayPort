import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AddressCard } from '@/components/address/AddressCard';
import { OutOfAreaNotice } from '@/components/address/OutOfAreaNotice';
import { PriceBreakdown } from '@/components/cart/PriceBreakdown';
import { deliveryNoteFor, useDeliveryQuote } from '@/hooks/useDeliveryQuote';
import { AuthLoadingScreen } from '@/components/auth/AuthLoadingScreen';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { StickyBottomBar, useStickyBarPadding } from '@/components/layout/StickyBottomBar';
import { OrderingPausedBanner } from '@/components/layout/OrderingPausedBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useOrderNotBefore } from '@/hooks/useOrderNotBefore';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore, useCartTotals } from '@/store/appStore';
import { useCatalogStore } from '@/store/catalogStore';
import { ensureLoggedIn } from '@/utils/authGate';
import { formatINR } from '@/utils/format';
import { formatLaunchDay } from '@/utils/launch';
import { isInServiceArea } from '@/utils/serviceArea';
import { formatSlot, formatWindow, isAsapAvailable, isValidScheduledStart } from '@/utils/serviceHours';

export default function CheckoutScreen() {
  const { horizontalPadding } = useResponsive();
  const stickyPad = useStickyBarPadding();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const authReady = useAppStore((s) => s.authReady);
  const cart = useAppStore((s) => s.cart);
  const addresses = useAppStore((s) => s.addresses);
  const selectedAddressId = useAppStore((s) => s.selectedAddressId);
  const totals = useCartTotals();
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const maxHours = Math.max(1, ...cart.map((c) => c.hours ?? 3));
  const notBefore = useOrderNotBefore();
  const scheduledValid = isValidScheduledStart(scheduledStartAt, new Date(), maxHours, notBefore);
  const timingOk = scheduledValid || (!scheduledStartAt && isAsapAvailable(new Date(), maxHours, notBefore));
  const address = addresses.find((a) => a.id === selectedAddressId) ?? addresses[0];
  const deliverable = Boolean(address) && isInServiceArea(address);
  const orderingPaused = useCatalogStore((s) => s.orderingPaused);
  const delivery = useDeliveryQuote();
  const deliveryReady = delivery.status === 'ready' && Boolean(delivery.quote);

  useEffect(() => {
    if (authReady && !isAuthenticated) {
      ensureLoggedIn('/checkout');
    }
  }, [authReady, isAuthenticated]);

  if (!authReady) return <AuthLoadingScreen />;

  if (!isAuthenticated) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Checkout" onBack={() => router.back()} />
        <EmptyState
          title="Log in to checkout"
          subtitle="Sign in to confirm address and place your rental."
          actionLabel="Log in"
          onAction={() => ensureLoggedIn('/checkout')}
        />
      </Screen>
    );
  }

  if (!cart.length) {
    return (
      <Screen showHeader={false} narrow>
        <ScreenHeader title="Checkout" onBack={() => router.back()} />
        <EmptyState
          title="Nothing to checkout"
          subtitle="Add a kit to your cart first."
          actionLabel="Explore"
          onAction={() => router.replace('/(tabs)')}
        />
      </Screen>
    );
  }

  const itemNames = cart.map((c) => c.name).join(' + ');

  return (
    <Screen showHeader={false} edges={['top']} narrow>
      <ScreenHeader
        title="Checkout"
        subtitle="Step 1 of 2 · Review"
        onBack={() => router.back()}
        right={
          <View style={styles.stepRight}>
            <View style={styles.stepDot} />
            <Text style={styles.stepMono}>REVIEW</Text>
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
        <OrderingPausedBanner style={{ marginBottom: 0 }} />
        {address ? (
          <AddressCard
            address={address}
            selected
            actionLabel="Change"
            onAction={() => router.push({ pathname: '/address', params: { select: '1' } })}
            onPress={() => router.push({ pathname: '/address', params: { select: '1' } })}
          />
        ) : null}
        {address && deliverable && delivery.status === 'needsPin' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pin this address on the map</Text>
            <Text style={styles.timingValue}>
              Delivery and pickup are free within 5 km of our hub; further away is charged by distance. We
              need the exact spot to work it out.
            </Text>
            <Button
              title="Pin location"
              variant="secondary"
              onPress={() => router.push(`/address/edit/${address.id}`)}
              fullWidth
            />
          </View>
        ) : null}
        {address && deliverable && delivery.status === 'error' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Couldn’t work out the delivery charge</Text>
            <Text style={styles.timingValue}>{delivery.error ?? 'Check your connection and try again.'}</Text>
            <Button title="Try again" variant="secondary" onPress={() => void delivery.refresh()} fullWidth />
          </View>
        ) : null}
        {address && !deliverable ? (
          <OutOfAreaNotice
            place={[address.area, address.city].filter(Boolean).join(', ')}
            actionLabel="Change address"
            onAction={() => router.push({ pathname: '/address', params: { select: '1' } })}
          />
        ) : null}
        {!address ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Delivery address required</Text>
            <Text style={styles.timingValue}>
              Add where we should drop off the kit before you pay.
            </Text>
            <Button
              title="Add delivery address"
              onPress={() => router.push({ pathname: '/address', params: { select: '1' } })}
              fullWidth
            />
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Delivery & Return Timing</Text>
          {scheduledValid && scheduledStartAt ? (
            <View style={styles.timingRow}>
              <Ionicons name="calendar-outline" size={16} color={colors.playportOrange} />
              <View style={{ flex: 1 }}>
                <View style={styles.timingHeader}>
                  <Text style={styles.timingLabel}>Scheduled dropoff</Text>
                  <Badge label="SCHEDULED" />
                </View>
                <Text style={styles.timingValue}>
                  {formatSlot(scheduledStartAt)} · {formatWindow(scheduledStartAt, maxHours)}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.timingRow}>
              <View style={{ flex: 1 }}>
                <View style={styles.timingHeader}>
                  <Text style={styles.timingLabel}>{scheduledStartAt ? 'Scheduled slot' : 'Express dropoff'}</Text>
                  {timingOk ? <Badge label="20–35 MINS" /> : null}
                </View>
                {timingOk ? (
                  <Text style={styles.timingValue}>
                    Rider heads out after payment — live minutes on Track once accepted.
                  </Text>
                ) : scheduledStartAt ? (
                  <Text style={styles.timingWarn}>
                    Your chosen slot is too soon or has passed. Go back to the cart and pick a new time, or switch
                    to ASAP.
                  </Text>
                ) : notBefore ? (
                  <Text style={styles.timingWarn}>
                    Your cart has a pre-book item. Go back to the cart and pick a time from{' '}
                    {formatLaunchDay(notBefore)} onwards.
                  </Text>
                ) : (
                  <Text style={styles.timingWarn}>
                    Too late for a {maxHours}h rental now — it would end after midnight, when we can’t pick
                    up. Go back to the cart to schedule it or choose a longer plan.
                  </Text>
                )}
              </View>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.timingRow}>
            <Ionicons name="calendar-outline" size={16} color={colors.secondaryText} />
            <View style={{ flex: 1 }}>
              <Text style={styles.timingLabel}>Automatic return pickup</Text>
              <Text style={styles.timingValue}>Doorstep pickup when your rental window ends</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.trustHeader}>
            <Ionicons name="shield-checkmark" size={18} color={colors.secondaryText} />
            <Text style={styles.cardTitle}>Secure rental</Text>
          </View>
          <Text style={styles.trustBody}>
            Kits are sanitized and pre-tested before dispatch. You’ll get live delivery minutes once a
            rider accepts.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.summaryHeader}>
            <Text style={styles.cardTitle}>Order Summary</Text>
            <Text style={styles.itemCount}>{totals.count} items booked</Text>
          </View>
          <Text style={styles.itemNames} numberOfLines={2}>
            {itemNames}
          </Text>
          <PriceBreakdown
            itemsTotal={totals.itemsTotal}
            taxes={totals.taxes}
            total={totals.total}
            delivery={deliveryReady ? delivery.quote : null}
            deliveryNote={deliveryNoteFor(delivery.status)}
          />
          <View style={styles.encryptRow}>
            <Ionicons name="lock-closed" size={14} color={colors.secondaryText} />
            <Text style={styles.encryptText}>
              256-Bit Bank Grade Encryption · 100% Refundable prior to dispatch
            </Text>
          </View>
        </View>
      </ScrollView>

      <StickyBottomBar>
        <View style={{ flex: 1 }}>
          <Text style={styles.stickyPrice}>{formatINR(totals.total)}</Text>
          <Text style={styles.stickyMeta}>ALL-INCLUSIVE</Text>
        </View>
        <Button
          title="Continue to Payment"
          iconRight={<Ionicons name="arrow-forward" size={16} color={colors.white} />}
          disabled={!deliverable || !deliveryReady || !timingOk || orderingPaused}
          onPress={() => {
            if (!deliverable || !deliveryReady || !timingOk || orderingPaused) return;
            router.push('/checkout/payment');
          }}
          style={styles.cta}
        />
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
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 10,
  },
  cardTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.title },
  timingRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  timingHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  timingLabel: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  timingValue: { color: colors.primaryText, fontFamily: fonts.body, fontSize: typeScale.body, marginTop: 4 },
  timingWarn: { color: colors.danger, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, marginTop: 4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle },
  returnBox: {
    alignSelf: 'flex-start',
    backgroundColor: colors.orangeTint,
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 8,
  },
  returnText: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.5,
  },
  trustHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  trustBody: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body, lineHeight: 19 },
  summaryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemCount: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.small },
  itemNames: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body, lineHeight: 18 },
  encryptRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 4 },
  encryptText: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    flex: 1,
    lineHeight: 17,
  },
  stickyPrice: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.headline },
  stickyMeta: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  cta: { minWidth: 180 },
});
