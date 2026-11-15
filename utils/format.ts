import { formatSlot, formatSlotTime } from './serviceHours';

export function formatINR(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

export function formatAddressLine(parts: {
  line1: string;
  line2?: string;
  area: string;
  city: string;
  pincode: string;
}): string {
  return [parts.line1, parts.line2, parts.area, `${parts.city} - ${parts.pincode}`]
    .filter(Boolean)
    .join(', ');
}

/** Rental end time in India, regardless of the server clock. */
export function formatReturnLabel(endAt?: string | null, fallback?: string): string {
  if (!endAt) return fallback ?? '';
  const date = new Date(endAt);
  if (Number.isNaN(date.getTime())) return fallback ?? '';
  const formatted = date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Returns ${formatted}`;
}

/**
 * The rental clock for a run card. Until handover the stored startAt/endAt are
 * only the booked slot — the real clock starts when the rider enters the
 * customer's 4-digit code, so an en-route rider must never read it as running.
 */
export interface RentalWindow {
  /** "Today, 2:12 pm" — booked start, or the live start once handover moved it. */
  startLabel: string;
  /** "8:12 pm" — end time, null when the order carries no end. */
  endLabel: string | null;
  /** "Today, 2:12 pm – 8:12 pm" */
  range: string;
  /** Whole booked hours, e.g. 6. */
  hours: number | null;
  /** Handover verified → the clock is running. */
  started: boolean;
}

export function rentalWindow(order: {
  startAt?: string;
  endAt?: string;
  deliveredAt?: string;
}): RentalWindow | null {
  if (!order.startAt) return null;
  const start = new Date(order.startAt);
  if (Number.isNaN(start.getTime())) return null;
  const end = order.endAt ? new Date(order.endAt) : null;
  const hasEnd = end != null && !Number.isNaN(end.getTime());
  const hours = hasEnd ? Math.round((end.getTime() - start.getTime()) / 3_600_000) : null;
  const startLabel = formatSlot(order.startAt);
  const endLabel = hasEnd ? formatSlotTime(order.endAt as string) : null;
  return {
    startLabel,
    endLabel,
    range: endLabel ? `${startLabel} – ${endLabel}` : startLabel,
    hours,
    started: Boolean(order.deliveredAt),
  };
}

export function orderStatusLabel(status: string): string {
  switch (status) {
    case 'pending_payment':
      return 'AWAITING PAYMENT';
    case 'confirmed':
      return 'CONFIRMED';
    case 'preparing':
      return 'PREPARING';
    case 'out_for_delivery':
      return 'OUT FOR DELIVERY';
    case 'delivered':
      return 'DELIVERED';
    case 'active':
      return 'ACTIVE';
    case 'returning':
      return 'RETURNING';
    case 'completed':
      return 'COMPLETED';
    case 'cancelled':
      return 'CANCELLED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return status.toUpperCase();
  }
}

/**
 * Rider-facing status label. "active" is really "the customer is using the kit",
 * which is what the rider cares about after handover.
 */
export function riderStatusLabel(status: string): string {
  return status === 'active' ? 'CUSTOMER USING KIT' : orderStatusLabel(status);
}

/** +919876543210 → "+91 98765 43210" so the number reads like one on a run card. */
export function prettyPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return phone;
}

/** One-line contact for Deliveries cards: "Priya · +91 98765 43210". */
export function riderContactLine(order: {
  customerName?: string | null;
  customerPhone?: string | null;
}): string | undefined {
  const line = [order.customerName, prettyPhone(order.customerPhone ?? undefined)]
    .filter(Boolean)
    .join(' · ');
  return line || undefined;
}

export function generateOrderId(): string {
  const n = Math.floor(10000 + Math.random() * 89999);
  return `PLP-${n}`;
}

export function searchProducts<
  T extends { name: string; shortName: string; tags: string[]; description: string; categoryId: string },
>(query: string, products: T[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return products.filter((p) => {
    const hay = `${p.name} ${p.shortName} ${p.description} ${p.tags.join(' ')} ${p.categoryId}`.toLowerCase();
    return hay.includes(q) || q.split(/\s+/).every((token) => hay.includes(token));
  });
}

export function calcCartTotals(
  items: { unitPrice: number; quantity: number; addonsTotal?: number; addons?: { unitPrice: number; quantity: number }[] }[],
  deliveryFee = 0
) {
  const itemsTotal = items.reduce((sum, item) => {
    const extras =
      item.addonsTotal ??
      (item.addons ?? []).reduce((s, a) => s + a.unitPrice * a.quantity, 0);
    return sum + (item.unitPrice + extras) * item.quantity;
  }, 0);
  const taxes = 0;
  const sanitization = 0;
  const delivery = items.length ? Math.max(0, Math.round(deliveryFee)) : 0;
  const deposit = 0;
  const total = itemsTotal + taxes + sanitization + delivery + deposit;
  return { itemsTotal, taxes, sanitization, delivery, deposit, total, count: items.reduce((s, i) => s + i.quantity, 0) };
}
