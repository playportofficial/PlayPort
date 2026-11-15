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

const FILTERS: { id: 'open' | 'all' | OrderStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = orders;
    if (filter === 'open') list = list.filter((o) => OPEN.includes(o.status));
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
          return (
            <Pressable
              key={o.id}
              style={adminStyles.card}
              onPress={() => router.push(`/admin/orders/${o.id}` as never)}
            >
              <View style={adminStyles.row}>
                <Text style={[adminStyles.cardTitle, { flex: 1 }]}>{o.id}</Text>
                <StatusBadge status={o.status} label={orderStatusLabel(o.status)} />
              </View>
              <Text style={adminStyles.cardMeta}>
                {o.addressLabel} · ₹{o.total} · {o.paymentStatus ?? '—'} · hub {o.hubId ?? '—'}
              </Text>
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
} as const;
