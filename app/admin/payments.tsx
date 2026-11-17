import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { colors, fonts, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { adminListPayments } from '@/lib/adminFirestore';
import { useAdminStore } from '@/store/adminStore';
import type { PaymentRecord } from '@/types';
import { deliverySlot } from '@/utils/serviceHours';

function moneyLabel(value: number) {
  return `₹${Math.round(Number(value) || 0)}`;
}

function whenLabel(iso?: string) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Every rupee Razorpay captured, newest first, tied back to the order it belongs to.
 * This is the screen that answers "he says he paid — who is he and what did he buy?"
 * when the order itself is missing, unconfirmed, or booked for a future slot.
 */
export default function AdminPaymentsScreen() {
  const { horizontalPadding } = useResponsive();
  const orders = useAdminStore((s) => s.orders);
  const loadOrders = useAdminStore((s) => s.loadOrders);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default on: "he says he paid" is the whole reason this screen exists.
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);

  const ordersById = useMemo(() => {
    const map = new Map<string, (typeof orders)[number]>();
    for (const order of orders) map.set(order.id, order);
    return map;
  }, [orders]);

  const load = () => {
    setLoading(true);
    setError(null);
    void loadOrders().catch(() => undefined);
    adminListPayments()
      .then(setPayments)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load payments'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = payments.map((payment) => {
    const order = ordersById.get(payment.orderId);
    const unmatched = !order || (order.paymentStatus !== 'paid' && order.paymentStatus !== 'cod');
    return { payment, order, unmatched };
  });
  const shown = onlyUnmatched ? rows.filter((row) => row.unmatched) : rows;
  const unmatchedCount = rows.filter((row) => row.unmatched).length;

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[
        adminStyles.scroll,
        { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl },
      ]}
    >
      <View style={adminStyles.row}>
        <View style={{ flex: 1 }}>
          <Text style={adminStyles.title}>Payments</Text>
          <Text style={adminStyles.subtitle}>
            {payments.length} captured{unmatchedCount ? ` · ${unmatchedCount} without a paid order` : ''}
          </Text>
        </View>
        <Pressable style={adminStyles.chip} onPress={load}>
          <Text style={adminStyles.chipText}>{loading ? 'Loading…' : 'Refresh'}</Text>
        </Pressable>
      </View>

      <View style={adminStyles.row}>
        <Pressable
          style={[adminStyles.chip, onlyUnmatched && adminStyles.chipActive]}
          onPress={() => setOnlyUnmatched((v) => !v)}
        >
          <Text style={[adminStyles.chipText, onlyUnmatched && adminStyles.chipTextActive]}>
            Needs attention{unmatchedCount ? ` · ${unmatchedCount}` : ''}
          </Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>Could not load payments: {error}</Text> : null}

      {shown.length === 0 && !loading ? (
        <Text style={adminStyles.empty}>
          {onlyUnmatched ? 'Every captured payment has a paid order.' : 'No payments yet.'}
        </Text>
      ) : (
        shown.map(({ payment, order, unmatched }) => {
          const slot = order ? deliverySlot(order) : null;
          return (
            <Pressable
              key={payment.id}
              style={[adminStyles.card, unmatched && styles.alertCard]}
              onPress={() => {
                if (order) router.push(`/admin/orders/${order.id}` as never);
              }}
            >
              <View style={adminStyles.row}>
                <Text style={[adminStyles.cardTitle, { flex: 1 }]}>
                  {moneyLabel(payment.amount)} · {payment.status}
                </Text>
                <Text style={styles.when}>{whenLabel(payment.createdAt)}</Text>
              </View>
              <Text style={adminStyles.cardMeta}>
                Order {payment.orderId || '—'} · {payment.provider}
                {payment.kind === 'extension' ? ' · extension' : ''}
              </Text>
              {order ? (
                <Text style={adminStyles.cardMeta}>
                  {order.customerName || 'Customer'} · {order.customerPhone || 'no phone'}
                  {order.addressLabel ? ` · ${order.addressLabel}` : ''}
                </Text>
              ) : null}
              {slot ? <Text style={adminStyles.cardMeta}>Slot {slot.window}</Text> : null}
              {unmatched ? (
                <Text style={styles.alertText}>
                  No paid order for this payment
                  {order ? ` (order is ${order.status}/${order.paymentStatus ?? '—'})` : ' — order record missing'}.
                  Reconcile before promising delivery.
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = {
  when: { color: colors.mutedText, fontFamily: fonts.mono, fontSize: 11 },
  alertCard: { borderColor: colors.playportOrange },
  alertText: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  error: {
    color: colors.playportOrange,
    fontFamily: fonts.body,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
} as const;
