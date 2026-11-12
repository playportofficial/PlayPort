import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, spacing } from '@/constants/theme';

function refundTimelineLabel(r: OrderRefund | undefined): string {
  if (!r) return '';
  if (r.status === 'processed' && r.providerRefundId) {
    return `Refund processed via Razorpay (refund ${r.providerRefundId}). ₹${formatINR(r.amount ?? 0)} sent back to the original payment method. It may take a few working days to show depending on the bank or payment provider.`;
  }
  if (r.status === 'processed') {
    return `Refund processed. ₹${formatINR(r.amount ?? 0)} being returned to the original payment method. It may take a few working days to show depending on the bank or payment provider.`;
  }
  if (r.status === 'pending') {
    if (r.providerRefundId) {
      return `Refund requested and in progress (Razorpay payment ${r.providerRefundId}). We’ll update this order when it’s confirmed. Expect it within 7 working days, sometimes a little longer depending on the bank or payment provider.`;
    }
    return `Refund recorded for the ops team to process manually. ₹${formatINR(r.amount ?? 0)} will be returned to your original payment method within 7 working days; your bank or payment provider may take a few extra days to show it.`;
  }
  if (r.status === 'failed') {
    return `Refund could not be completed automatically: ${r.error ?? 'unknown error'}. Please contact PlayPort on WhatsApp so we can sort it out.`;
  }
  return `Refund requested. ₹${formatINR(r.amount ?? 0)} will be returned to your original payment method within 7 working days; your bank or payment provider may take a few extra days to show it.`;
}

function renderRefundRecord(r: OrderRefund | null | undefined): React.ReactElement | null {
  if (!r) return null;
  return (
    <>
      <Text style={adminStyles.cardMeta}>{refundTimelineLabel(r)}</Text>
      {r.by && (
        <Text style={adminStyles.cardMeta}>Refunded by: {r.by === 'staff' ? 'PlayPort ops' : 'the customer'}.</Text>
      )}
      {r.reason && <Text style={adminStyles.cardMeta}>Reason: {r.reason}</Text>}
      {r.note && <Text style={adminStyles.cardMeta}>Ops note: {r.note}</Text>}
    </>
  );
}
import { useResponsive } from '@/hooks/useResponsive';
import { adminGetOrder, adminNextStatuses, adminRefundOrder } from '@/lib/adminFirestore';
import { adminAssignRider, riderListRiders } from '@/lib/riderFirestore';
import { useAdminStore } from '@/store/adminStore';
import type { Order, OrderRefund, OrderStatus, Rider } from '@/types';
import { formatINR } from '@/utils/format';
import { orderStatusLabel } from '@/utils/format';

export default function AdminOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding } = useResponsive();
  const advanceOrder = useAdminStore((s) => s.advanceOrder);
  const [order, setOrder] = useState<Order | null>(null);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundDone, setRefundDone] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [o, r] = await Promise.all([adminGetOrder(id), riderListRiders()]);
      setOrder(o);
      setRiders(r.filter((x) => x.active));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [id]);

  const onAdvance = async (status: OrderStatus) => {
    setError(null);
    setBusy(true);
    try {
      await advanceOrder(id, status);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const onRefund = async () => {
    if (!order || refundBusy) return;
    if (order.paymentStatus !== 'paid') {
      setRefundError(
        order.paymentStatus === 'cod'
          ? 'This order was cash on delivery — there is nothing to refund.'
          : 'This order has not been paid yet.'
      );
      return;
    }
    if (order.status === 'cancelled' || order.status === 'completed' || order.status === 'refunded') {
      setRefundError('Order is already closed');
      return;
    }
    if (order.refundProcessed) {
      setRefundError('A refund has already been processed for this order');
      return;
    }
    setRefundError(null);
    setRefundBusy(true);
    try {
      await adminRefundOrder(id, 'Refunded by staff', 'Refunded from the ops console');
      setRefundDone(true);
      await reload();
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : 'Refund failed');
    } finally {
      setRefundBusy(false);
    }
  };

  const onAssign = async (rider: Rider) => {
    setError(null);
    setBusy(true);
    try {
      await adminAssignRider(id, rider);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assign failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[adminStyles.page, { paddingTop: spacing.xxl, alignItems: 'center' }]}>
        <ActivityIndicator color={colors.playportOrange} />
      </View>
    );
  }

  if (!order) {
    return (
      <View style={[adminStyles.page, { padding: spacing.xl }]}>
        <Text style={adminStyles.empty}>Order not found.</Text>
        <Button title="Back" size="sm" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const next = adminNextStatuses(order.status);

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[adminStyles.scroll, { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl }]}
    >
      <Button title="← Deliveries" size="sm" variant="ghost" onPress={() => router.back()} />
      <View style={adminStyles.row}>
        <Text style={[adminStyles.title, { flex: 1 }]}>{order.id}</Text>
        <StatusBadge status={order.status} label={orderStatusLabel(order.status)} />
      </View>
      <Text style={adminStyles.subtitle}>
        {order.addressFull || order.addressLabel} · payment {order.paymentStatus ?? '—'}
      </Text>

      <View style={adminStyles.card}>
        <Text style={adminStyles.cardTitle}>Items</Text>
        {order.items?.map((item, idx) => (
          <View key={`${item.name}-${idx}`} style={{ marginBottom: 8 }}>
            <Text style={adminStyles.cardMeta}>
              {item.name} · {item.durationLabel} · ₹{item.price}
            </Text>
            {item.extras?.map((extra) => (
              <Text key={extra} style={adminStyles.cardMeta}>
                {extra}
              </Text>
            ))}
          </View>
        ))}
        <Text style={[adminStyles.cardMeta, { marginTop: 8 }]}>
          Total ₹{order.total} · hub {order.hubId ?? '—'} · progress {order.progressPercent}%
        </Text>
      </View>

      <View style={adminStyles.card}>
        <Text style={adminStyles.cardTitle}>Rider</Text>
        {order.riderName ? (
          <Text style={adminStyles.cardMeta}>
            {order.riderName}
            {order.riderPhone ? ` · ${order.riderPhone}` : ''}
          </Text>
        ) : (
          <Text style={adminStyles.cardMeta}>Unassigned — pick a rider below</Text>
        )}
        <View style={adminStyles.row}>
          {riders.length === 0 ? (
            <Text style={adminStyles.cardMeta}>No active riders. Add one under Admin → Riders.</Text>
          ) : (
            riders.map((r) => (
              <Button
                key={r.id}
                title={r.name}
                size="sm"
                variant={order.riderId === r.id ? 'primary' : 'secondary'}
                disabled={busy}
                onPress={() => void onAssign(r)}
              />
            ))
          )}
        </View>
      </View>

      <View style={adminStyles.card}>
        <Text style={adminStyles.cardTitle}>Payment / refund</Text>
        <Text style={adminStyles.cardMeta}>
          Payment {order.paymentStatus ?? '—'} · paid amount ₹{order.total} · {order.paymentMethodLabel ?? '—'}
        </Text>
        {order.paymentStatus === 'paid' && order.refundProcessed ? (
          <View style={{ marginTop: 8 }}>
            <Text style={adminStyles.cardMeta}>Refund already processed for this order.</Text>
            {renderRefundRecord(order.refund)}
          </View>
        ) : order.paymentStatus === 'refunded' ? (
          <View style={{ marginTop: 8 }}>
            <Text style={adminStyles.cardMeta}>Marked refunded.</Text>
            {renderRefundRecord(order.refund)}
          </View>
        ) : order.paymentStatus === 'paid' && order.status !== 'cancelled' && order.status !== 'completed' && order.status !== 'refunded' && !order.refundProcessed ? (
          <>
            <Text style={[adminStyles.cardMeta, { marginTop: 8 }]}>
              This order has been paid. Refund it from here when the kit can’t be delivered (for example, when the booked equipment is unavailable). The refund path moves the money back where Razorpay is configured; today it records a manual refund when the gateway is not live.
            </Text>
            <Button
              title={refundBusy ? 'Refunding…' : 'Refund this order'}
              variant="danger"
              size="sm"
              disabled={refundBusy || !!refundError}
              onPress={() => void onRefund()}
            />
            {refundError ? <Text style={adminStyles.error}>{refundError}</Text> : null}
            {refundDone ? <Text style={[adminStyles.cardMeta, { color: colors.success }]}>Refund submitted. Reload to see the result.</Text> : null}
          </>
        ) : order.paymentStatus === 'cod' ? (
          <Text style={[adminStyles.cardMeta, { marginTop: 8 }]}>
            Cash on delivery — there is no online payment to refund. If the customer needs this cancelled, cancel the order in the status stepper above.
          </Text>
        ) : (
          <Text style={[adminStyles.cardMeta, { marginTop: 8 }]}>
            This order has not been paid yet. If it won’t be fulfilled, cancel it in the status stepper above.
          </Text>
        )}
      </View>

      <View style={adminStyles.card}>
        <Text style={adminStyles.cardTitle}>Advance status</Text>
        {next.length === 0 ? (
          <Text style={adminStyles.cardMeta}>No further transitions.</Text>
        ) : (
          <View style={adminStyles.row}>
            {next.map((s) => (
              <Button
                key={s}
                title={orderStatusLabel(s)}
                size="sm"
                variant={s === 'cancelled' || s === 'refunded' ? 'danger' : 'primary'}
                disabled={busy}
                onPress={() => void onAdvance(s)}
              />
            ))}
          </View>
        )}
        {error ? <Text style={adminStyles.error}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}
