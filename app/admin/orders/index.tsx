import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAdminStore } from '@/store/adminStore';
import type { OrderStatus } from '@/types';
import { orderStatusLabel } from '@/utils/format';

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

  const filtered = useMemo(() => {
    if (filter === 'all') return orders;
    if (filter === 'open') return orders.filter((o) => OPEN.includes(o.status));
    return orders.filter((o) => o.status === filter);
  }, [orders, filter]);

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[adminStyles.scroll, { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl }]}
    >
      <View style={adminStyles.row}>
        <View style={{ flex: 1 }}>
          <Text style={adminStyles.title}>Deliveries</Text>
          <Text style={adminStyles.subtitle}>{filtered.length} orders</Text>
        </View>
        <Pressable style={adminStyles.chip} onPress={() => void loadOrders()}>
          <Text style={adminStyles.chipText}>Refresh</Text>
        </Pressable>
      </View>

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
        <Text style={adminStyles.empty}>No orders in this filter.</Text>
      ) : (
        filtered.map((o) => (
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
            <Text style={adminStyles.cardMeta}>{o.items?.map((i) => i.name).join(', ')}</Text>
            {o.refund ? (
              <Text style={adminStyles.cardMeta}>
                Refund {o.refund.status === 'processed' ? 'processed' : o.refund.status === 'failed' ? 'had an issue' : 'pending'} · ₹{o.total}
                {o.refund.providerRefundId ? ` · Razorpay ${o.refund.providerRefundId}` : ''}
              </Text>
            ) : null}
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
