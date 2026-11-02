import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { callCollectCodPayment } from '@/lib/functions';
import { riderGetOrder, watchOrder } from '@/lib/riderFirestore';
import { geocodeAddress } from '@/lib/deliveryEta';
import { useRiderStore } from '@/store/riderStore';
import type { Order, OrderStatus } from '@/types';
import { useNow } from '@/hooks/useNow';
import { orderStatusLabel } from '@/utils/format';
import { formatSlot } from '@/utils/serviceHours';
import { isEnRoute, locationAgeLabel, remainingEtaMinutes } from '@/utils/liveEta';

const RIDER_NEXT: Record<string, { status: OrderStatus; label: string }[]> = {
  preparing: [{ status: 'out_for_delivery', label: 'Start delivery' }],
  out_for_delivery: [{ status: 'delivered', label: 'Mark delivered / setup done' }],
  delivered: [
    { status: 'active', label: 'Customer using kit' },
    { status: 'returning', label: 'Start return pickup' },
  ],
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

  const isMine = order?.riderId && rider && order.riderId === rider.id;
  const canClaim = order && !order.riderId && ['confirmed', 'preparing'].includes(order.status);
  const next = order ? RIDER_NEXT[order.status] ?? [] : [];

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
        <StatusBadge status={order.status} label={orderStatusLabel(order.status)} />
      </View>
      <Text style={styles.sub}>
        Hub {order.hubId ?? '—'} · payment {order.paymentStatus ?? '—'}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Drop-off</Text>
        <Text style={styles.meta}>{order.addressFull || order.addressLabel}</Text>
        {order.startAt ? (
          <Text style={styles.meta}>Starts {formatSlot(order.startAt)}</Text>
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

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Items</Text>
        {order.items?.map((item, idx) => (
          <Text key={`${item.name}-${idx}`} style={styles.meta}>
            {item.name} · {item.durationLabel} · ₹{item.price}
          </Text>
        ))}
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

      {isMine &&
      order.paymentStatus === 'cod' &&
      ['delivered', 'active', 'returning', 'completed'].includes(order.status) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cash to collect</Text>
          <Text style={styles.meta}>
            Collect ₹{order.total} from the customer for this booking before you leave.
          </Text>
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
                    title={busy ? 'Verifying…' : isPickup ? 'Verify & complete order' : 'Verify & mark delivered'}
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
  meta: { fontFamily: fonts.body, fontSize: typeScale.small, color: colors.secondaryText, lineHeight: 18 },
  error: { fontFamily: fonts.body, color: colors.danger, fontSize: typeScale.body },
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
