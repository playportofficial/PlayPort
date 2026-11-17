import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fonts, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAdminStore } from '@/store/adminStore';
import type { OrderStatus } from '@/types';
import { orderStatusLabel } from '@/utils/format';
import { deliverySlot } from '@/utils/serviceHours';

const FILTERS: { id: 'open' | 'all' | 'scheduled' | 'attention' | OrderStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'attention', label: 'Attention' },
  { id: 'all', label: 'All' },
  { id: 'pending_payment', label: 'Unpaid' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'out_for_delivery', label: 'Out' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'active', label: 'Active' },
  { id: 'returning', label: 'Returning' },
  { id: 'completed', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'refunded', label: 'Refunded' },
];

const OPEN: OrderStatus[] = [
  'pending_payment',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
  'active',
  'returning',
];

/** Cancelled / failed checkouts that still look like money may have moved — ops must see them. */
function needsAttention(order: { status: string; paymentStatus?: string | null; razorpayOrderId?: string | null; cancelReason?: string | null }) {
  if (order.status === 'cancelled' || order.status === 'refunded') {
    if (order.paymentStatus === 'paid') return true;
    if (order.razorpayOrderId && (order.paymentStatus === 'failed' || order.paymentStatus === 'pending')) return true;
    if (order.cancelReason === 'Payment hold expired') return true;
  }
  return false;
}

export default function AdminOrdersScreen() {
  const { horizontalPadding } = useResponsive();
  const orders = useAdminStore((s) => s.orders);
  const loadOrders = useAdminStore((s) => s.loadOrders);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void loadOrders().catch((err) => {
      // An empty screen and a failed read look identical otherwise — which is how a
      // real booking can appear to not exist.
      setError(err instanceof Error ? err.message : 'Could not load orders');
    });
  };

  const attentionCount = useMemo(() => orders.filter(needsAttention).length, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = orders;
    if (filter === 'open') list = list.filter((o) => OPEN.includes(o.status));
    else if (filter === 'scheduled')
      // Pre-booked runs, soonest first — the ones that never show up in a rider's
      // pool because their slot is still days away.
      list = list
        .filter(
          (o) =>
            OPEN.includes(o.status) && o.startAt && new Date(o.startAt).getTime() > Date.now()
        )
        .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
    else if (filter === 'attention')
      list = list
        .filter(needsAttention)
        .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    else if (filter !== 'all') list = list.filter((o) => o.status === filter);
    if (!q) return list;
    const digits = q.replace(/\D/g, '');
    return list.filter((o) => {
      const haystack = [
        o.id,
        o.customerName,
        o.customerPhone,
        o.addressLabel,
        o.addressFull,
        o.userId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (haystack.includes(q)) return true;
      // Phone search must survive spaces, +91 and formatting.
      return digits.length >= 4 && haystack.replace(/\D/g, '').includes(digits);
    });
  }, [orders, filter, query]);

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
          <Text style={adminStyles.title}>Deliveries</Text>
          <Text style={adminStyles.subtitle}>
            {filtered.length} orders{query.trim() ? ` matching “${query.trim()}”` : ''}
            {attentionCount ? ` · ${attentionCount} need attention` : ''}
          </Text>
        </View>
        <Pressable style={adminStyles.chip} onPress={refresh}>
          <Text style={adminStyles.chipText}>Refresh</Text>
        </Pressable>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search order id, phone, name or address"
        placeholderTextColor={colors.mutedText}
        autoCapitalize="none"
        style={styles.search}
      />

      {attentionCount > 0 && filter !== 'attention' ? (
        <Pressable
          style={styles.attentionBanner}
          onPress={() => setFilter('attention')}
          accessibilityRole="button"
        >
          <Text style={styles.attentionTitle}>
            {attentionCount} checkout{attentionCount === 1 ? '' : 's'} may have paid money
          </Text>
          <Text style={styles.attentionBody}>
            Hold-expired or cancelled bookings with a Razorpay attempt. Open Attention (or Payments) before
            telling the customer there is no order.
          </Text>
        </Pressable>
      ) : null}

      {error ? (
        <Text style={styles.error}>
          Could not load orders: {error}
          {'\n'}This is a load failure, not an empty list — pull Refresh.
        </Text>
      ) : null}

      <View style={adminStyles.row}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.id}
            style={[adminStyles.chip, filter === f.id && adminStyles.chipActive]}
            onPress={() => setFilter(f.id)}
          >
            <Text style={[adminStyles.chipText, filter === f.id && adminStyles.chipTextActive]}>
              {f.label}
              {f.id === 'attention' && attentionCount ? ` · ${attentionCount}` : ''}
            </Text>
          </Pressable>
        ))}
      </View>

      {filtered.length === 0 ? (
        <Text style={adminStyles.empty}>
          No orders in this filter{query.trim() ? ' for that search' : ''}.
        </Text>
      ) : (
        filtered.map((o) => {
          const slot = deliverySlot(o);
          const flag = needsAttention(o);
          return (
            <Pressable
              key={o.id}
              style={[adminStyles.card, flag && styles.attentionCard]}
              onPress={() => router.push(`/admin/orders/${o.id}` as never)}
            >
              <View style={adminStyles.row}>
                <Text style={[adminStyles.cardTitle, { flex: 1 }]}>{o.id}</Text>
                <StatusBadge status={o.status} label={orderStatusLabel(o.status)} />
              </View>
              <Text style={adminStyles.cardMeta}>
                {[o.customerName, o.customerPhone].filter(Boolean).join(' · ') || 'No contact'}
                {o.addressLabel ? ` · ${o.addressLabel}` : ''} · ₹{o.total} · {o.paymentStatus ?? '—'}
              </Text>
              {flag && o.cancelReason ? (
                <Text style={styles.attentionBody}>{o.cancelReason}</Text>
              ) : null}
              {slot ? <Text style={adminStyles.cardMeta}>Slot {slot.window}</Text> : null}
              <Text style={adminStyles.cardMeta}>
                {o.items?.map((i) => i.name).join(', ')}
              </Text>
              {o.refund ? (
                <Text style={adminStyles.cardMeta}>
                  Refund{' '}
                  {o.refund.status === 'processed'
                    ? 'processed'
                    : o.refund.status === 'failed'
                      ? 'had an issue'
                      : 'pending'}{' '}
                  · ₹{o.total}
                  {o.refund.providerRefundId ? ` · Razorpay ${o.refund.providerRefundId}` : ''}
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
  search: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.primaryText,
    fontFamily: fonts.body,
    fontSize: 14,
    marginVertical: spacing.sm,
  },
  error: {
    color: colors.playportOrange,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  attentionBanner: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.playportOrange,
    borderRadius: 12,
    padding: spacing.md,
    gap: 4,
    marginBottom: spacing.sm,
  },
  attentionCard: { borderColor: colors.playportOrange },
  attentionTitle: {
    color: colors.playportOrange,
    fontFamily: fonts.heading,
    fontSize: 14,
  },
  attentionBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
  },
} as const;
