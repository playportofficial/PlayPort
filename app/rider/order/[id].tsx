import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { callCollectCodPayment } from '@/lib/functions';
import { riderGetOrder, riderGetRunContact, watchOrder } from '@/lib/riderFirestore';
import { geocodeAddress } from '@/lib/deliveryEta';
import { useRiderStore } from '@/store/riderStore';
import type { RunContact } from '@/lib/functions';
import type { Order, OrderStatus } from '@/types';
import { useNow } from '@/hooks/useNow';
import { rentalWindow, riderStatusLabel } from '@/utils/format';
import { deliverySlot, formatLate, isDispatchable } from '@/utils/serviceHours';
import { isEnRoute, locationAgeLabel, remainingEtaMinutes } from '@/utils/liveEta';

/** +919876543210 → "+91 98765 43210" so the number reads like one. */
function prettyPhone(phone?: string): string | undefined {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return phone;
}

/** One-line "what now" per status, so an accepted run explains itself. */
const NEXT_STEP: Partial<Record<OrderStatus, string>> = {
  confirmed: 'Accept this run to lock it in — the customer is waiting for a rider.',
  preparing: 'Pick up the kit from the hub, then tap "Start delivery".',
  out_for_delivery:
    'Ride to the address. At the door, ask for the customer\u2019s 4-digit handover code and enter it — that starts their rental clock.',
  delivered:
    'Handover done and the rental clock is running. Collect cash if this is COD, then start the return pickup when their time is up.',
  active:
    'The customer is using the kit — their clock started at handover. Head back when the rental ends and tap "Start return pickup".',
  returning:
    'Collect the kit and check the accessories, then enter the customer\u2019s pickup code to close the run.',
};

const RIDER_NEXT: Record<string, { status: OrderStatus; label: string }[]> = {
  preparing: [{ status: 'out_for_delivery', label: 'Start delivery' }],
  // Verifying the door code writes the order straight to "active", so there is no
  // separate "Customer using kit" tap to forget.
  out_for_delivery: [{ status: 'delivered', label: 'Verify handover & start clock' }],
  delivered: [{ status: 'returning', label: 'Start return pickup' }],
  active: [{ status: 'returning', label: 'Start return pickup' }],
  returning: [{ status: 'completed', label: 'Return complete' }],
};

export default function RiderOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding } = useResponsive();
  const rider = useRiderStore((s) => s.rider);
  const accept = useRiderStore((s) => s.accept);
  const setStatus = useRiderStore((s) => s.setStatus);
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryCode, setDeliveryCode] = useState('');
  const [contact, setContact] = useState<RunContact | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      setOrder(await riderGetOrder(id));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDeliveryCode('');
  }, [order?.status]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    return watchOrder(id, (live) => {
      setOrder(live);
      setLoading(false);
    });
  }, [id]);

  const enRoute = order ? isEnRoute(order.status) : false;
  const now = useNow(enRoute && !loading);
  const liveMinutes = remainingEtaMinutes(order, now);
  const liveAge = locationAgeLabel(order?.riderLocationUpdatedAt, now);

  const hasDropoffCoords =
    order != null &&
    Number.isFinite(order.dropoffLat) &&
    Number.isFinite(order.dropoffLng) &&
    !(Math.abs(order.dropoffLat as number) < 0.001 && Math.abs(order.dropoffLng as number) < 0.001);

  const mapsUrl = hasDropoffCoords
    ? // Exact pin + turn-by-turn — avoids ambiguous text search (e.g. multiple "Green Meadows").
      `https://www.google.com/maps/dir/?api=1&destination=${order?.dropoffLat},${order?.dropoffLng}`
    : order?.addressFull
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.addressFull)}`
      : null;

  const openMaps = async () => {
    // Exact doorstep pin first (Zepto-style: coords saved with the address).
    // If the order predates pins, geocode on-demand so we still get a direct
    // pin instead of an ambiguous text search.
    let dest: string | null = null;
    if (hasDropoffCoords && order) {
      dest = `${order.dropoffLat},${order.dropoffLng}`;
    } else {
      const q = order?.addressFull || order?.addressLabel || '';
      if (!q) return;
      try {
        const geo = await geocodeAddress(q);
        if (geo) dest = `${geo.lat},${geo.lng}`;
      } catch {
        dest = null;
      }
      if (!dest) {
        await Linking.openURL(
          `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
        );
        return;
      }
    }
    // Android: jump straight into turn-by-turn in Google Maps.
    // iOS/web: universal link opens the route to the exact pin.
    if (Platform.OS === 'android') {
      const navUrl = `google.navigation:q=${dest}`;
      try {
        if (await Linking.canOpenURL(navUrl)) {
          await Linking.openURL(navUrl);
          return;
        }
      } catch {
        // fall through to universal link
      }
    }
    await Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${dest}`);
  };

  // Newer bookings carry the number on the order; older ones need the server lookup
  // because riders can't read the customer's saved address under the rules.
  const customerPhone = order?.customerPhone ?? contact?.customerPhone ?? undefined;
  const customerName = order?.customerName ?? contact?.customerName ?? undefined;
  const doorNotes = order?.addressInstructions ?? contact?.addressInstructions ?? undefined;

  const callCustomer = () => {
    const phone = customerPhone?.replace(/[^\d+]/g, '');
    if (!phone) return;
    void Linking.openURL(`tel:${phone}`);
  };

  const fetchContact = () => {
    if (!order) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const found = await riderGetRunContact(order.id);
        setContact(found);
        if (!found.customerPhone && !found.customerName) {
          setError('No contact on file for this booking — ask ops to check the customer’s address.');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not fetch the customer number');
      } finally {
        setBusy(false);
      }
    })();
  };

  const isMine = order?.riderId && rider && order.riderId === rider.id;
  const next = order ? RIDER_NEXT[order.status] ?? [] : [];
  const rental = order ? rentalWindow(order) : null;
  const nextStep = order ? NEXT_STEP[order.status] ?? null : null;

  // Both the label and the gate come from the *delivery slot*: a 24h rental booked
  // for 11:13 AM is late at 2 PM, not "starting at 11:13 AM" all afternoon.
  const slot = order ? deliverySlot(order) : null;
  const isExpired = Boolean(order?.expiredAt);
  const slotClosed = slot?.state === 'closed';
  const canClaim =
    Boolean(order) &&
    !order!.riderId &&
    ['confirmed', 'preparing'].includes(order!.status) &&
    isDispatchable(order);
  const claimBlocked =
    !canClaim &&
    !isMine &&
    Boolean(order) &&
    (isExpired || slotClosed || !['confirmed', 'preparing'].includes(order!.status));

  const paymentLabel =
    order?.paymentStatus === 'cod'
      ? 'cash on delivery'
      : order?.paymentStatus === 'paid'
        ? 'paid online'
        : order?.paymentStatus ?? '—';
  const cashCollected = order?.paymentStatus === 'paid' && order?.paymentProvider === 'cod';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.page, styles.center]}>
        <ActivityIndicator color={colors.playportOrange} />
      </View>
    );
  }

  if (!order) {
    return (
      <View style={[styles.page, { padding: spacing.xl }]}>
        <Text style={styles.empty}>Order not found.</Text>
        <Button title="Back" size="sm" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.scroll, { paddingHorizontal: horizontalPadding }]}
    >
      <Button title="← Back" size="sm" variant="ghost" onPress={() => router.back()} />
      <View style={styles.row}>
        <Text style={[styles.title, { flex: 1 }]}>{order.id}</Text>
        <StatusBadge status={order.status} label={riderStatusLabel(order.status)} />
      </View>
      <Text style={styles.sub}>
        Pickup hub {order.hubId ?? '—'} · {paymentLabel}
      </Text>

      {isMine && nextStep ? (
        <View style={[styles.card, styles.nextStep]}>
          <Text style={styles.cardTitle}>Next step</Text>
          <Text style={styles.meta}>{nextStep}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Drop-off</Text>
        <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
        {order.deliveryKm ? (
          <Text style={styles.meta}>About {order.deliveryKm} km from the hub</Text>
        ) : null}
        <Text style={styles.meta}>ETA {order.etaLabel}</Text>
        {mapsUrl ? (
          <Button
            title="Open in Maps"
            size="sm"
            variant="secondary"
            onPress={() => void openMaps()}
          />
        ) : null}
      </View>

      {slot ? (
        <View style={[styles.card, slot.state !== 'upcoming' && styles.cardWarn]}>
          <Text style={styles.cardTitle}>Delivery slot</Text>
          <Text style={styles.emphasis}>{slot.window}</Text>
          <Text style={slot.state === 'upcoming' ? styles.meta : styles.blocked}>{slot.note}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Customer</Text>
        {customerName || customerPhone ? (
          <Text style={styles.emphasis}>
            {[customerName, prettyPhone(customerPhone)].filter(Boolean).join(' · ')}
          </Text>
        ) : (
          <Text style={styles.meta}>No contact saved on this booking yet.</Text>
        )}
        {doorNotes ? <Text style={styles.meta}>Door notes: {doorNotes}</Text> : null}
        {customerPhone ? (
          <Button title="Call customer" size="sm" variant="secondary" onPress={callCustomer} />
        ) : (
          <>
            <Text style={styles.meta}>
              This booking predates saved contact. Look the number up from the customer’s booked
              address.
            </Text>
            <Button
              title={busy ? 'Looking up…' : 'Get customer number'}
              size="sm"
              variant="secondary"
              disabled={busy}
              onPress={fetchContact}
            />
          </>
        )}
      </View>

      {isMine && !slotClosed && !isExpired && rental ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Rental clock</Text>

          {rental.started ? (
            <>
              <Text style={styles.emphasis}>
                Running{rental.hours ? ` · ${rental.hours}h` : ''}
              </Text>
              <Text style={styles.meta}>
                Clock started {rental.startLabel} at handover.
                {rental.endLabel
                  ? ` Customer returns ${rental.endLabel} — plan the pickup around that.`
                  : ' Start the return pickup once the customer is done.'}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.emphasis}>Not started yet</Text>
              <Text style={styles.meta}>
                The{rental.hours ? ` ${rental.hours}-hour` : ''} clock starts the moment you enter the
                customer’s 4-digit handover code at the door — not when you accept the run.
              </Text>
              <Text style={styles.meta}>
                Booked slot: {rental.range}. Reaching late does not cut their time; it starts at
                handover.
              </Text>
            </>
          )}
        </View>
      ) : isMine && (slotClosed || isExpired) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Slot status</Text>
          <Text style={styles.blocked}>
            {isExpired
              ? 'This order was expired before handover. The rental clock should not be running.'
              : 'The booked window has closed. Ops must review this run — the customer’s original slot is in the past, so a late dispatch needs their agreement, a reschedule, or a refund.'}
          </Text>
          {slot ? (
            <Text style={styles.meta}>
              Booked window: {slot.window}
              {slot.overdueMinutes > 0
                ? ` · closed ${formatLate(slot.overdueMinutes)} ago`
                : ''}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Items</Text>
        {order.items?.map((item, idx) => (
          <View key={`${item.name}-${idx}`} style={styles.itemLine}>
            <Text style={styles.meta}>
              {item.name} · {item.durationLabel} · ₹{item.price}
            </Text>
            {item.extras?.map((extra) => (
              <Text key={extra} style={styles.meta}>
                {extra}
              </Text>
            ))}
          </View>
        ))}
        {order.deliveryFee ? (
          <Text style={styles.meta}>
            Delivery ₹{order.deliveryFee}
            {order.deliveryKm ? ` · ${order.deliveryKm} km` : ''}
          </Text>
        ) : null}
        <Text style={[styles.meta, { marginTop: 8 }]}>Total ₹{order.total}</Text>
      </View>

      {order.riderName ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Assigned rider</Text>
          <Text style={styles.meta}>
            {order.riderName}
            {order.riderPhone ? ` · ${order.riderPhone}` : ''}
          </Text>
        </View>
      ) : null}

      {isMine && (order.status === 'out_for_delivery' || order.status === 'returning') ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Customer ETA</Text>
          <Text style={styles.meta}>
            {liveMinutes != null
              ? `About ${liveMinutes} min${order.riderDistanceKm ? ` · ${order.riderDistanceKm} km` : ''}`
              : 'Waiting for a location update'}
            {liveAge ? ` · ${liveAge}` : ''}
          </Text>
          <Text style={styles.meta}>
            Keep this screen open (or the app in foreground) so GPS updates their countdown. No map
            is shared with the customer.
          </Text>
        </View>
      ) : null}

      {isMine && (order.paymentStatus === 'cod' || cashCollected) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cash to collect</Text>
          {cashCollected ? (
            <Text style={styles.meta}>
              ₹{order.total} collected — payment is settled for this run.
            </Text>
          ) : (
            <>
              <Text style={styles.meta}>
                Collect ₹{order.total} in cash from the customer for this booking.
              </Text>
              {['delivered', 'active', 'returning', 'completed'].includes(order.status) ? (
                <Button
                  title={busy ? 'Recording…' : `Mark ₹${order.total} collected`}
                  size="sm"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await callCollectCodPayment(order.id);
                    })
                  }
                />
              ) : (
                <Text style={styles.meta}>
                  The "collected" button unlocks once the handover code is verified.
                </Text>
              )}
            </>
          )}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Actions</Text>
        {canClaim ? (
          <Button
            title={busy ? 'Accepting…' : 'Accept this run'}
            size="sm"
            disabled={busy}
            onPress={() => void run(() => accept(order.id))}
          />
        ) : claimBlocked ? (
          <Text style={styles.blocked}>
            {isExpired
              ? 'This order’s delivery slot has expired. A rider can’t accept it — ops needs to review it first.'
              : slotClosed
                ? 'This order’s delivery slot has already passed. A rider can’t accept it directly — ops needs to confirm a late dispatch first.'
                : 'This order isn’t open for acceptance right now.'}
          </Text>
        ) : null}
        {isMine && next.length > 0
          ? next.map((action) => {
              const isPickup = action.status === 'completed';
              const needsOtp = isPickup
                ? Boolean(order.pickupOtpRequired)
                : action.status === 'delivered' && Boolean(order.deliveryOtp);
              if (!needsOtp) {
                return (
                  <Button
                    key={action.status}
                    title={busy ? 'Updating…' : action.label}
                    size="sm"
                    disabled={busy}
                    onPress={() => void run(() => setStatus(order.id, action.status))}
                  />
                );
              }
              const codeReady = deliveryCode.replace(/\D/g, '').length === 4;
              return (
                <View key={action.status} style={styles.otpBlock}>
                  <Text style={styles.otpTitle}>{isPickup ? 'Pickup verification' : 'Handover verification'}</Text>
                  <Text style={styles.otpHint}>
                    {isPickup
                      ? 'Collect the kit, then ask the customer for the 4-digit pickup code on their order screen.'
                      : 'Ask the customer for the 4-digit code shown on their tracking screen.'}
                  </Text>
                  <TextInput
                    value={deliveryCode}
                    onChangeText={(t) => setDeliveryCode(t.replace(/\D/g, '').slice(0, 4))}
                    placeholder="0000"
                    placeholderTextColor={colors.mutedText}
                    keyboardType="number-pad"
                    maxLength={4}
                    style={styles.otpInput}
                  />
                  <Button
                    title={
                      busy
                        ? 'Verifying…'
                        : isPickup
                          ? 'Verify & complete order'
                          : 'Verify handover code'
                    }
                    size="sm"
                    disabled={busy || !codeReady}
                    onPress={() =>
                      void run(() =>
                        setStatus(order.id, action.status, deliveryCode.replace(/\D/g, ''))
                      )
                    }
                  />
                </View>
              );
            })
          : null}
        {isMine && next.length === 0 ? (
          <Text style={styles.meta}>No further rider actions for this status.</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: spacing.xxl },
  scroll: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontFamily: fonts.heading, fontSize: typeScale.headline, color: colors.primaryText },
  sub: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.secondaryText },
  empty: { fontFamily: fonts.body, color: colors.mutedText },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 8,
  },
  cardTitle: { fontFamily: fonts.heading, fontSize: typeScale.title, color: colors.primaryText },
  emphasis: { fontFamily: fonts.heading, fontSize: typeScale.body, color: colors.primaryText },
  nextStep: { borderColor: colors.playportOrange },
  cardWarn: { borderColor: colors.playportOrange },
  itemLine: { gap: 2 },
  meta: { fontFamily: fonts.body, fontSize: typeScale.small, color: colors.secondaryText, lineHeight: 18 },
  error: { fontFamily: fonts.body, color: colors.danger, fontSize: typeScale.body },
  blocked: { fontFamily: fonts.body, color: colors.danger, fontSize: typeScale.body, lineHeight: 18 },
  otpBlock: {
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  otpTitle: {
    fontFamily: fonts.heading,
    fontSize: typeScale.body,
    color: colors.primaryText,
  },
  otpHint: {
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    color: colors.secondaryText,
    lineHeight: 17,
  },
  otpInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.page,
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 24,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 10,
  },
});
