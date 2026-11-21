import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import {
  cartItemHours,
  expectedLineTotal,
  experienceAddonOptions,
  normalizeFnProduct,
  priceForAddon,
  type FnAddon,
  istDayStartMs,
  priceForHourly,
  productForStart,
  type FnCartItem,
  type FnProduct,
} from './rentalPricing';
import { isDropoffInServiceArea, OUT_OF_AREA_ERROR, SERVICE_CENTER, SERVICE_RADIUS_KM } from './serviceArea';
import { DELIVERY_RATE_PER_KM, FREE_DELIVERY_KM, quoteDeliveryFee, TRIPS_PER_ORDER } from './delivery';

initializeApp();
const db = getFirestore();

const REGION = 'asia-south1';
/** Must match constants/legal.ts LEGAL_VERSION — bump both when the policies change. */
const LEGAL_VERSION = '2026-10-26';
/**
 * Payment hold TTL before inventory is released automatically.
 * Long enough for slow UPI / netbanking so a captured Razorpay payment is not
 * orphaned by the hold sweeper while the customer is still on the bank page.
 */
const HOLD_TTL_MS = 30 * 60 * 1000;

const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['cancelled'],
  confirmed: ['preparing', 'cancelled', 'refunded'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'active', 'cancelled'],
  delivered: ['active', 'returning'],
  active: ['returning'],
  returning: ['completed'],
  completed: [],
  cancelled: [],
  refunded: [],
};

const razorpayKeyId = defineString('RAZORPAY_KEY_ID', { default: '' });
/** Optional — empty = demo checkout (confirmPayment). Set via params when going live. */
const razorpayKeySecret = defineString('RAZORPAY_KEY_SECRET', { default: '' });
const razorpayWebhookSecret = defineString('RAZORPAY_WEBHOOK_SECRET', { default: '' });
const googleMapsApiKey = defineString('GOOGLE_MAPS_API_KEY', { default: '' });

/** Refund gateways configured (Razorpay) — used by the refund and pre-slot paths. */
const refundGatewayLive = Boolean(razorpayKeySecret.value());

/**
 * Server-side shape of the refund record we write onto orders/{id}.refund.
 * Kept in sync with the app/shared OrderRefund type in ../types/index.ts.
 */
type RefundRecord = {
  requestedAt: string;
  by: 'customer' | 'staff';
  reason?: string;
  note?: string;
  providerRef?: string;
  providerRefundId?: string;
  amount?: number;
  error?: string;
  status?: 'pending' | 'processed' | 'failed';
  updatedAt: string;
};

/** Local mirror of the shared OpsNotification type (types/index.ts). */
type OpsNotification = {
  kind: 'new_order' | 'payment_received' | 'dispatch' | 'refund' | 'flag' | 'system';
  title: string;
  body: string;
  orderId?: string;
  severity: 'info' | 'warning' | 'critical';
  read: boolean;
  createdAt: string;
  eventAt: string;
};

type CartItem = FnCartItem & {
  id: string;
  name: string;
  image: string;
  durationLabel: string;
  includesNote?: string;
};

/** Razorpay checkout signature = HMAC_SHA256(order_id|payment_id, key_secret). */
function validRazorpaySignature(razorpayOrderId: string, paymentId: string, signature: string): boolean {
  const secret = razorpayKeySecret.value();
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(`${razorpayOrderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

function razorpayClient(): { orders: { fetch: (id: string) => Promise<{ status?: string; amount_paid?: number }> }; payments: { fetch: (id: string) => Promise<{ id: string; status?: string; order_id?: string; amount?: number }> } } | null {
  const keyId = razorpayKeyId.value();
  const keySecret = razorpayKeySecret.value();
  if (!keyId || !keySecret) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/**
 * Look up whether Razorpay already captured money for one of our checkout orders.
 * Returns the payment id when paid; null when still open / failed / unknown.
 */
async function razorpayCapturedPaymentId(razorpayOrderId: string | null | undefined): Promise<string | null> {
  if (!razorpayOrderId || razorpayOrderId.startsWith('demo_')) return null;
  const rzp = razorpayClient();
  if (!rzp) return null;
  try {
    const order = await rzp.orders.fetch(razorpayOrderId);
    if (order?.status === 'paid' && Number(order.amount_paid) > 0) {
      // Prefer a real payment id when the payments collection already has one.
      const paySnap = await db.collection('payments').doc(razorpayOrderId).get();
      const existing = paySnap.data()?.providerRef;
      if (typeof existing === 'string' && existing.startsWith('pay_')) return existing;
      return razorpayOrderId;
    }
  } catch (err) {
    logger.warn('Razorpay order fetch failed', { razorpayOrderId, error: String(err) });
  }
  return null;
}

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  return uid;
}

function refundAmountFor(order: DocumentData | null): number {
  if (!order) return 0;
  return Math.round(Number(order.total) || 0);
}

/**
 * Run the real refund path for a paid order — the piece that was missing before,
 * where cancelBooking only reassigned paymentStatus to 'refunded' without moving
 * any money back through Razorpay.
 *
 * It is intentionally idempotent: if refundProcessed is already true / a refund
 * record already exists, the function returns the current state instead of
 * attempting a second Razorpay refund.
 *
 * Degrades cleanly when the gateway is not configured: it still writes a refund
 * record so the app can explain what happened (manual refund, to be completed by
 * ops), but it does not claim a Razorpay refund ID it cannot obtain.
 */
async function executeRefundInternal(
  ref: DocumentReference,
  order: DocumentData,
  by: 'customer' | 'staff',
  reason?: string,
  staffNote?: string
) {
  const nowIso = new Date().toISOString();
  const existing = (order.refund as RefundRecord | undefined) ?? null;

  // Already refunded via a previous attempt — do not re-run the gateway.
  if (order.paymentStatus === 'refunded') {
    if (!existing) {
      // Heal an order that was marked refunded without a refund record (legacy path).
      await ref.update({
        refund: {
          requestedAt: nowIso,
          by,
          reason: reason ?? order.cancelReason ?? undefined,
          note: staffNote ?? undefined,
          status: 'pending',
          updatedAt: nowIso,
        },
        refundProcessed: true,
        refundNote: staffNote ?? undefined,
      });
      return { refunded: true, manual: true, existing: false, gatewayUsed: false };
    }
    return {
      refunded: true,
      manual: !refundGatewayLive,
      existing: true,
      gatewayUsed: !!existing.providerRefundId,
      record: existing,
    };
  }

  if (existing?.status === 'processed') {
    return { refunded: true, manual: false, existing: true, gatewayUsed: true, record: existing };
  }

  // A pending/refunding gateway attempt is already in flight — do not start another.
  if (existing?.status === 'pending' && existing.providerRefundId) {
    return { refunded: false, manual: false, existing: true, gatewayUsed: false, record: existing, inFlight: true };
  }

  const amount = refundAmountFor(order);
  if (amount <= 0) {
    throw new HttpsError('failed-precondition', 'Nothing to refund — the order has no paid total');
  }

  const recordBase = {
    requestedAt: nowIso,
    by,
    reason: reason ?? order.cancelReason ?? undefined,
    note: staffNote ?? undefined,
    amount,
    updatedAt: nowIso,
  } as RefundRecord;

  // When the gateway is not live, record the intent and leave the money movement
  // to ops (manual refund). Do not pretend a Razorpay refund happened.
  if (!refundGatewayLive || !order.razorpayPaymentId) {
    const record = {
      ...recordBase,
      status: 'pending',
      updatedAt: nowIso,
    };
    await ref.update({
      paymentStatus: 'refunded',
      refund: record,
      refundProcessed: true,
      refundNote: staffNote ?? undefined,
    });
    logger.info('Refund recorded as manual/pending', {
      orderId: order.id,
      by,
      gatewayLive: refundGatewayLive,
      hasRazorpayPayment: Boolean(order.razorpayPaymentId),
    });
    return { refunded: true, manual: true, existing: false, gatewayUsed: false, record };
  }

  // Real gateway refund path.
  const rzpPaymentId = order.razorpayPaymentId as string;
  const payRef = db.collection('payments').doc(rzpPaymentId);
  const paySnap = await payRef.get();
  const pay = paySnap.data();
  if (!paySnap.exists || !pay || pay.orderId !== order.id) {
    // The Razorpay payment reference on the order does not match a known payment.
    // Record the failure so the app can show it, but keep the order as paid so ops
    // can investigate rather than silently shadowing the money.
    const record: RefundRecord = {
      ...recordBase,
      status: 'failed',
      error: 'Razorpay payment reference not found for this order',
      updatedAt: nowIso,
    };
    await ref.update({ refund: record, refundProcessed: true, refundNote: staffNote ?? undefined });
    logger.warn('Refund aborted: payment ref missing', { orderId: order.id, rzpPaymentId });
    return { refunded: false, manual: false, existing: false, gatewayUsed: false, record };
  }

  if (pay.status === 'refunded') {
    // Gateway already refunded this payment (e.g. webhook came in just before us).
    // Reconcile the order to reflect that without issuing a second refund.
    const record: RefundRecord = {
      ...recordBase,
      status: 'processed',
      providerRefundId: pay.providerRef ?? undefined,
      updatedAt: nowIso,
    };
    await ref.update({
      paymentStatus: 'refunded',
      refund: record,
      refundProcessed: true,
      refundNote: staffNote ?? undefined,
    });
    return { refunded: true, manual: false, existing: false, gatewayUsed: true, record };
  }

  if (pay.status !== 'paid') {
    const record: RefundRecord = {
      ...recordBase,
      status: 'failed',
      error: `Payment is not in a refundable state (gateway status: ${pay.status})`,
      updatedAt: nowIso,
    };
    await ref.update({ refund: record, refundProcessed: true, refundNote: staffNote ?? undefined });
    logger.warn('Refund aborted: payment not refundable', { orderId: order.id, rzpPaymentId, payStatus: pay.status });
    return { refunded: false, manual: false, existing: false, gatewayUsed: false, record };
  }

  // Refund via Razorpay.
  // Dynamic import keeps the cold start lean when the gateway is not configured.
  let rzp: { refunds: { create: (args: { payment_id: string; amount: number; notes?: Record<string, unknown> }) => Promise<{ id: string; status: string }> } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Razorpay = require('razorpay');
    rzp = new Razorpay({ key_id: razorpayKeyId.value(), key_secret: razorpayKeySecret.value() });
  } catch (err) {
    const record: RefundRecord = {
      ...recordBase,
      status: 'failed',
      error: 'Refund gateway could not be initialised',
      updatedAt: nowIso,
    };
    await ref.update({ refund: record, refundProcessed: true, refundNote: staffNote ?? undefined });
    logger.error('Refund gateway initialisation failed', { orderId: order.id, err: String(err) });
    return { refunded: false, manual: false, existing: false, gatewayUsed: false, record };
  }

  let refundCapture: { id: string; status: string } | null = null;
  try {
    refundCapture = await rzp.refunds.create({
      payment_id: rzpPaymentId,
      amount,
      notes: {
        orderId: order.id,
        userId: order.userId ?? undefined,
        by,
        reason: reason ?? order.cancelReason ?? undefined,
        staffNote: staffNote ?? undefined,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Razorpay refund call failed', { orderId: order.id, rzpPaymentId, err: message });
    const record: RefundRecord = {
      ...recordBase,
      status: 'failed',
      error: message,
      updatedAt: nowIso,
    };
    await ref.update({ refund: record, refundProcessed: true, refundNote: staffNote ?? undefined });
    return { refunded: false, manual: false, existing: false, gatewayUsed: true, record };
  }

  if (!refundCapture) {
    const record: RefundRecord = {
      ...recordBase,
      status: 'failed',
      error: 'Razorpay returned no refund result',
      updatedAt: nowIso,
    };
    await ref.update({ refund: record, refundProcessed: true, refundNote: staffNote ?? undefined });
    return { refunded: false, manual: false, existing: false, gatewayUsed: true, record };
  }

  const refundStatus: RefundRecord['status'] = refundCapture.status === 'processed' ? 'processed' : 'pending';
  const record: RefundRecord = {
    ...recordBase,
    status: refundStatus,
    providerRef: rzpPaymentId,
    providerRefundId: refundCapture.id,
    amount,
    updatedAt: nowIso,
  };

  await ref.update({
    paymentStatus: 'refunded',
    refund: record,
    refundProcessed: true,
    refundNote: staffNote ?? undefined,
  });
  await payRef.update({ status: 'refunded', providerRefundId: refundCapture.id, refundAmount: amount, updatedAt: nowIso });

  logger.info('Refund processed via gateway', {
    orderId: order.id,
    rzpPaymentId,
    refundId: refundCapture.id,
    amount,
    status: refundCapture.status,
  });

  return { refunded: true, manual: false, existing: false, gatewayUsed: true, record };
}

function orderId() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `PP-${new Date().getFullYear()}-${n}`;
}

function formatInIndia(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

async function clearUserCart(uid: string) {
  const cartSnap = await db.collection('users').doc(uid).collection('cart').get();
  await Promise.all(cartSnap.docs.map((d) => d.ref.delete()));
}

function lineClientTotal(c: CartItem): number {
  const extras = c.addonsTotal ?? (c.addons ?? []).reduce((s, a) => s + a.unitPrice * a.quantity, 0);
  return (c.unitPrice + extras) * c.quantity;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

function isActiveReservation(
  status: string,
  holdExpiresAt: string | null | undefined,
  now: number
) {
  if (status === 'confirmed') return true;
  if (status === 'hold') {
    if (!holdExpiresAt) return true;
    return new Date(holdExpiresAt).getTime() > now;
  }
  return false;
}

async function pushNotification(
  userId: string,
  payload: { title: string; body: string; type: string; orderId?: string }
) {
  const ref = db.collection('users').doc(userId).collection('notifications').doc();
  const createdAt = new Date().toISOString();
  await ref.set({
    id: ref.id,
    title: payload.title,
    body: payload.body,
    type: payload.type,
    orderId: payload.orderId ?? null,
    read: false,
    createdAt,
    timeLabel: 'Just now',
  });

  const userSnap = await db.collection('users').doc(userId).get();
  const tokens: string[] = userSnap.data()?.fcmTokens ?? [];
  if (!tokens.length) return;

  try {
    await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: { type: payload.type, orderId: payload.orderId ?? '' },
    });
  } catch (err) {
    logger.warn('FCM send failed', err);
  }
}

type NotifyPayload = { title: string; body: string; type: string; orderId?: string };

/**
 * Riders sign in with the same auth uid as customers, but their profile lives in
 * `riders/`, so every customer-side push above misses them. Rider alerts use the
 * same per-user inbox the app renders, which is what makes them visible in the
 * Alerts tab even when the browser blocks the system notification.
 */
async function notifyRider(riderId: string | null | undefined, payload: NotifyPayload) {
  if (!riderId) return;
  try {
    await pushNotification(riderId, payload);
  } catch (err) {
    logger.warn('Rider push failed', { riderId, error: String(err) });
  }
}

/**
 * A dispatchable run has to reach every active rider in its hub, not only whoever
 * happens to have the Available tab open. Equality filters only, so no composite
 * index is needed.
 */
async function notifyHubRiders(
  hubId: unknown,
  payload: NotifyPayload,
  exceptRiderId?: string | null
) {
  if (typeof hubId !== 'string' || !hubId) return;
  try {
    const snap = await db
      .collection('riders')
      .where('active', '==', true)
      .where('hubId', '==', hubId)
      .get();
    await Promise.all(
      snap.docs.filter((d) => d.id !== exceptRiderId).map((d) => notifyRider(d.id, payload))
    );
  } catch (err) {
    logger.warn('Rider broadcast failed', { hubId, error: String(err) });
  }
}

/**
 * Ops devices, resolved from the same allowlist firestore.rules uses for isOps().
 * Cached per instance so a burst of orders doesn't re-list auth users each time.
 */
let opsUidsCache: { at: number; uids: string[] } | null = null;

async function resolveOpsUids(): Promise<string[]> {
  if (opsUidsCache && Date.now() - opsUidsCache.at < 5 * 60 * 1000) return opsUidsCache.uids;
  const uids: string[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const page = await getAuth().listUsers(1000, pageToken);
      for (const account of page.users) {
        const phone = (account.phoneNumber ?? '').replace(/\D/g, '');
        if (
          account.customClaims?.admin === true ||
          account.email === 'paulabraham.net@gmail.com' ||
          phone.endsWith('9346577926')
        ) {
          uids.push(account.uid);
        }
      }
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (err) {
    logger.warn('Could not resolve ops accounts for push', { error: String(err) });
  }
  opsUidsCache = { at: Date.now(), uids };
  return uids;
}

/**
 * Staff awareness for anything that costs or earns money. The `ops_notifications`
 * doc is the durable record the admin app lists; the push is what makes someone
 * actually look. Writing the doc first means a push failure never loses the alert.
 */
async function notifyOps(payload: {
  kind: OpsNotification['kind'];
  severity: OpsNotification['severity'];
  title: string;
  body: string;
  orderId?: string;
}) {
  const nowIso = new Date().toISOString();
  try {
    await db.collection('ops_notifications').doc().set({
      kind: payload.kind,
      severity: payload.severity,
      title: payload.title,
      body: payload.body,
      orderId: payload.orderId ?? null,
      read: false,
      createdAt: nowIso,
      eventAt: nowIso,
    });
  } catch (err) {
    logger.error('Could not write ops alert', { title: payload.title, error: String(err) });
  }

  const uids = await resolveOpsUids();
  if (!uids.length) return;
  await Promise.all(
    uids.map((uid) =>
      pushNotification(uid, {
        title: payload.title,
        body: payload.body,
        type: 'order',
        orderId: payload.orderId,
      }).catch((err) => logger.warn('Ops push failed', { uid, error: String(err) }))
    )
  );
}

/** One-line order summary for a rider alert: where, how long, how much. */
function runSummary(order: Record<string, any>): string {
  const where = order.addressLabel || order.addressFull || 'Delivery';
  const hours = typeof order.hours === 'number' ? ` · ${order.hours}h` : '';
  return `${where}${hours} · ₹${Math.round(Number(order.total) || 0)}`;
}

async function resolveHubId(requested?: string, userId?: string): Promise<string> {
  if (requested) {
    const snap = await db.collection('hubs').doc(requested).get();
    if (snap.exists && snap.data()?.active !== false) return snap.id;
  }
  if (userId) {
    const user = await db.collection('users').doc(userId).get();
    const homeHubId = user.data()?.homeHubId as string | undefined;
    if (homeHubId) {
      const snap = await db.collection('hubs').doc(homeHubId).get();
      if (snap.exists && snap.data()?.active !== false) return snap.id;
    }
  }
  const active = await db.collection('hubs').where('active', '==', true).limit(1).get();
  if (active.empty) throw new HttpsError('failed-precondition', 'No active hub configured');
  return active.docs[0].id;
}

const SERVICE_OPEN_HOUR_IST = 6;
const SERVICE_CLOSE_HOUR_IST = 24;
const NIGHT_START_HOUR_IST = 18;
const NIGHT_MAX_HOURS = 6;

function istHourFromMs(ms: number): number {
  return new Date(ms + 5.5 * 60 * 60 * 1000).getUTCHours();
}

/**
 * Pickup rules (IST), mirrored from utils/serviceHours:
 * - Daytime starts: end must land in service hours (6 AM – midnight).
 * - Night starts (6 PM+): only packages ≤ 6h (overnight end before 6 AM is OK).
 */
function rentalWindowAllowed(startMs: number, hours: number): boolean {
  if (!Number.isFinite(hours) || hours <= 0) return false;
  const startH = istHourFromMs(startMs);
  if (startH >= NIGHT_START_HOUR_IST) return hours <= NIGHT_MAX_HOURS;
  return istHourFromMs(startMs + hours * 60 * 60 * 1000) >= SERVICE_OPEN_HOUR_IST;
}

/** Pre-book products: availableFrom "YYYY-MM-DD" = 12:00 AM IST that day. Mirrors utils/serviceHours launchStart. */
function launchStartMs(availableFrom: unknown): number | null {
  if (typeof availableFrom !== 'string' || !availableFrom.trim()) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(availableFrom.trim());
  const ms = day
    ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - 5.5 * 60 * 60 * 1000
    : new Date(availableFrom).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const launchDayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });

function assertLaunched(startMs: number, availableFrom: unknown, name: string): void {
  const launch = launchStartMs(availableFrom);
  if (launch != null && startMs < launch) {
    throw new HttpsError(
      'failed-precondition',
      `${name} rentals start from ${launchDayFmt.format(new Date(launch))} — pick a time from then onwards.`
    );
  }
}

function validLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

async function deliveryQuoteFor(hubId: string, dropoff: { lat: number; lng: number }) {
  const hub = (await db.collection('hubs').doc(hubId).get()).data();
  const origin = validLatLng(hub?.lat, hub?.lng);
  if (!origin) throw new HttpsError('failed-precondition', 'Hub location is not set — ops must pin the hub');
  return quoteDeliveryFee(origin, dropoff, googleMapsApiKey.value());
}

/** Delivery + pickup charge for a pinned address: free within 5 km, then ₹7/km on all 4 trips. */
export const quoteDelivery = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { hubId: requestedHubId, lat, lng } = (request.data || {}) as {
    hubId?: string;
    lat?: number;
    lng?: number;
  };
  const dropoff = validLatLng(lat, lng);
  if (!dropoff) throw new HttpsError('invalid-argument', 'Pin the address on the map first');
  if (!isDropoffInServiceArea(dropoff)) {
    throw new HttpsError('failed-precondition', OUT_OF_AREA_ERROR);
  }
  const hubId = await resolveHubId(requestedHubId, uid);
  const quote = await deliveryQuoteFor(hubId, dropoff);
  return {
    ...quote,
    hubId,
    freeKm: FREE_DELIVERY_KM,
    ratePerKm: DELIVERY_RATE_PER_KM,
    trips: TRIPS_PER_ORDER,
    serviceable: quote.km <= SERVICE_RADIUS_KM,
  };
});

/** Admin → Settings defaults: rider travel out before a rental, pickup + return + cleaning after. */
const DEFAULT_BUFFER_BEFORE_MIN = 40;
const DEFAULT_BUFFER_AFTER_MIN = 40;
/** Spare controllers shared by every kit (the one in each kit's box isn't counted). */
const DEFAULT_CONTROLLER_STOCK = 10;
let opsCache: { at: number; beforeMs: number; afterMs: number; controllerStock: number } | null = null;

async function opsSettings() {
  if (opsCache && Date.now() - opsCache.at < 60 * 1000) return opsCache;
  const cfg = (await db.collection('config').doc('app').get()).data() ?? {};
  const bounded = (value: unknown, fallback: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
  };
  opsCache = {
    at: Date.now(),
    beforeMs: bounded(cfg.bufferBeforeMinutes, DEFAULT_BUFFER_BEFORE_MIN, 240) * 60 * 1000,
    afterMs: bounded(cfg.bufferAfterMinutes, DEFAULT_BUFFER_AFTER_MIN, 240) * 60 * 1000,
    controllerStock: Math.floor(bounded(cfg.controllerStock, DEFAULT_CONTROLLER_STOCK, 500)),
  };
  return opsCache;
}

async function bookingBuffersMs(): Promise<{ beforeMs: number; afterMs: number }> {
  return opsSettings();
}

function isControllerAddonLike(addon: { id?: string; name?: string }): boolean {
  return addon.id === 'extra-controller' || /controller/i.test(addon.name ?? '');
}

/** Spare controllers already out (with travel buffers) during [startMs, endMs]. */
async function controllersInUse(startMs: number, endMs: number, now: number, excludeOrderId?: string) {
  const { beforeMs, afterMs } = await opsSettings();
  const snap = await db.collection('inventory_reservations').where('kind', '==', 'controllers').get();
  let used = 0;
  for (const doc of snap.docs) {
    const r = doc.data();
    if (excludeOrderId && r.orderId === excludeOrderId) continue;
    if (!isActiveReservation(r.status, r.holdExpiresAt, now)) continue;
    const rStart = new Date(r.startAt).getTime();
    const rEnd = new Date(r.endAt).getTime();
    if (rangesOverlap(startMs - beforeMs, endMs + afterMs, rStart - beforeMs, rEnd + afterMs)) {
      used += Math.max(0, Number(r.quantity) || 0);
    }
  }
  return used;
}

async function assertControllersFree(
  wanted: number,
  startMs: number,
  endMs: number,
  now: number,
  excludeOrderId?: string
) {
  if (wanted <= 0) return;
  const { controllerStock } = await opsSettings();
  const free = Math.max(0, controllerStock - (await controllersInUse(startMs, endMs, now, excludeOrderId)));
  if (wanted > free) {
    throw new HttpsError(
      'resource-exhausted',
      free === 0
        ? 'No extra controllers are free for that time — remove the extra controller or pick another slot.'
        : `Only ${free} extra controller${free === 1 ? ' is' : 's are'} free for that time — reduce the extras or pick another slot.`
    );
  }
}

/**
 * A unit is out of the hub from (start − travel out) until (end + pickup/return),
 * so two rentals clash when those wider windows overlap — not just the rental hours.
 */
async function unitHasOverlap(
  unitId: string,
  startMs: number,
  endMs: number,
  now: number,
  excludeOrderId?: string
): Promise<boolean> {
  const { beforeMs, afterMs } = await bookingBuffersMs();
  const snap = await db
    .collection('inventory_reservations')
    .where('inventoryUnitId', '==', unitId)
    .where('status', 'in', ['hold', 'confirmed'])
    .get();

  for (const doc of snap.docs) {
    const r = doc.data();
    if (excludeOrderId && r.orderId === excludeOrderId) continue;
    if (!isActiveReservation(r.status, r.holdExpiresAt, now)) continue;
    const rStart = new Date(r.startAt).getTime();
    const rEnd = new Date(r.endAt).getTime();
    if (rangesOverlap(startMs - beforeMs, endMs + afterMs, rStart - beforeMs, rEnd + afterMs)) return true;
  }
  return false;
}

async function pickUnitsForProduct(
  productId: string,
  hubId: string,
  quantity: number,
  startMs: number,
  endMs: number,
  now: number,
  preferredUnitIds: string[] = []
): Promise<string[]> {
  const unitsSnap = await db
    .collection('inventory_units')
    .where('productId', '==', productId)
    .where('hubId', '==', hubId)
    .where('status', '==', 'available')
    .get();

  const preferred = new Set(preferredUnitIds.filter(Boolean));
  const docs = [...unitsSnap.docs].sort((a, b) => {
    const rank = (id: string) => (preferred.has(id) ? 0 : 1);
    return rank(a.id) - rank(b.id);
  });

  const picked: string[] = [];
  for (const doc of docs) {
    if (picked.length >= quantity) break;
    // Launch-day consoles (e.g. GTA 6 units) can't go out before their date.
    const from = istDayStartMs(doc.data().availableFrom);
    if (from != null && startMs < from) continue;
    const busy = await unitHasOverlap(doc.id, startMs, endMs, now);
    if (!busy) picked.push(doc.id);
  }
  if (preferred.size > 0 && !picked.some((id) => preferred.has(id))) {
    throw new HttpsError(
      'failed-precondition',
      'The unit you chose is not free for that window'
    );
  }
  if (picked.length < quantity) {
    throw new HttpsError(
      'resource-exhausted',
      `Not enough free units for ${productId} in the selected window`
    );
  }
  return picked;
}

async function releaseReservations(reservationIds: string[], toStatus: 'released' | 'completed') {
  const nowIso = new Date().toISOString();
  await Promise.all(
    reservationIds.map(async (id) => {
      const ref = db.collection('inventory_reservations').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return;
      const status = snap.data()?.status;
      if (status === 'released' || status === 'completed') return;
      await ref.update({ status: toStatus, holdExpiresAt: null, updatedAt: nowIso });
    })
  );
}

async function markOrderPaymentFailedOrCancelled(
  orderRef: DocumentReference,
  order: DocumentData,
  reason: string
) {
  // Payment-failure paths must never cancel an order that has been paid.
  if (order.paymentStatus === 'paid') return;
  const reservationIds: string[] = order.reservationIds ?? [];
  await releaseReservations(reservationIds, 'released');
  await orderRef.update({
    status: 'cancelled',
    paymentStatus: order.paymentStatus === 'paid' ? 'refunded' : 'failed',
    holdExpiresAt: null,
    progressPercent: 0,
    cancelReason: reason,
    cancelledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Customer contact for the rider's run screen. Read from the saved address that
 * was actually booked (never trusted blindly from the client), with the profile
 * and the default address as fallbacks for older app versions.
 */
type CustomerContact = {
  customerName?: string;
  customerPhone?: string;
  addressInstructions?: string;
};

function cleanPhone(phone: unknown): string | undefined {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : undefined;
}

function cleanText(value: unknown, max: number): string | undefined {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

function contactFromAddress(data: DocumentData | undefined): CustomerContact {
  if (!data) return {};
  const contact: CustomerContact = {};
  const name = cleanText(data.contactName, 60);
  const phone = cleanPhone(data.phone);
  const instructions = cleanText(data.instructions, 240);
  if (name) contact.customerName = name;
  if (phone) contact.customerPhone = phone;
  if (instructions) contact.addressInstructions = instructions;
  return contact;
}

async function resolveCustomerContact(
  uid: string,
  addressId?: string,
  addressFull?: string
): Promise<CustomerContact> {
  try {
    if (addressId) {
      const snap = await db.collection('users').doc(uid).collection('addresses').doc(addressId).get();
      const contact = contactFromAddress(snap.exists ? snap.data() : undefined);
      if (contact.customerPhone) return contact;
    }
    // Legacy bookings carry no addressId — match the saved address by its text,
    // else fall back to the customer's default address.
    const snapshot = await db.collection('users').doc(uid).collection('addresses').get();
    const target = String(addressFull ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    let fallback: CustomerContact = {};
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const text = [data.line1, data.line2, data.area, data.city, data.pincode]
        .filter(Boolean)
        .join(', ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const contact = contactFromAddress(data);
      if (target && text === target && contact.customerPhone) return contact;
      // A default address is a safe fallback for who to call, never for door
      // notes — those belong to the address the order was actually placed for.
      if (data.isDefault === true && contact.customerPhone) {
        fallback = { customerName: contact.customerName, customerPhone: contact.customerPhone };
      }
    }
    if (fallback.customerPhone) return fallback;

    const profile = (await db.collection('users').doc(uid).get()).data();
    const contact: CustomerContact = {};
    const name = cleanText(profile?.name, 60);
    const phone = cleanPhone(profile?.phone);
    if (name) contact.customerName = name;
    if (phone) contact.customerPhone = phone;
    return contact;
  } catch (err) {
    logger.warn('customer contact lookup failed', { uid, err: String(err) });
    return {};
  }
}

// ——— createBooking ———

export const createBooking = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const {
    hubId: requestedHubId,
    cart,
    addressLabel,
    addressFull,
    addressId,
    dropoffLat: dropoffLatInput,
    dropoffLng: dropoffLngInput,
    paymentMethodLabel,
    subtotal,
    total,
    startAt: startAtInput,
    payOnDelivery,
    termsVersion,
  } = request.data as {
    hubId?: string;
    cart: CartItem[];
    addressLabel: string;
    addressFull: string;
    /** Saved address doc id — contact name, phone and door instructions for the rider. */
    addressId?: string;
    dropoffLat?: number;
    dropoffLng?: number;
    paymentMethodLabel: string;
    subtotal: number;
    taxes: number;
    total: number;
    startAt?: string;
    payOnDelivery?: boolean;
    termsVersion?: string;
  };

  // Admin → Settings "Pause ordering" (config/app.maintenanceMode) stops new bookings.
  const appConfig = (await db.collection('config').doc('app').get()).data();
  if (appConfig?.maintenanceMode === true) {
    throw new HttpsError(
      'unavailable',
      String(appConfig.maintenanceMessage || '').trim() ||
        'We’re not taking new orders right now. Please check back soon.'
    );
  }

  // Terms 3.7: the checkout tick is the customer's agreement; we keep the version and time.
  if (termsVersion !== LEGAL_VERSION) {
    throw new HttpsError(
      'failed-precondition',
      'Please review and accept the latest Terms & Conditions, Refund Policy and Privacy Policy to book.'
    );
  }

  const isCod = payOnDelivery === true;

  if (!Array.isArray(cart) || !cart.length) {
    throw new HttpsError('invalid-argument', 'Cart is empty');
  }
  if (!addressFull || String(addressFull).trim().length < 8) {
    throw new HttpsError('invalid-argument', 'Delivery address required');
  }
  if (
    !isDropoffInServiceArea({
      lat: typeof dropoffLatInput === 'number' ? dropoffLatInput : undefined,
      lng: typeof dropoffLngInput === 'number' ? dropoffLngInput : undefined,
      addressFull,
    })
  ) {
    throw new HttpsError('failed-precondition', OUT_OF_AREA_ERROR);
  }

  const hubId = await resolveHubId(requestedHubId, uid);
  const now = Date.now();
  const startAt = startAtInput ? new Date(startAtInput) : new Date(now + 45 * 60 * 1000);
  if (Number.isNaN(startAt.getTime())) {
    throw new HttpsError('invalid-argument', 'Invalid startAt');
  }
  // Service hours (IST): dropoffs run 6 AM – midnight. After 6 PM only ≤6h packages.
  if (startAt.getTime() < now - 5 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'That slot already passed — pick a new time');
  }
  if (startAt.getTime() > now + 31 * 24 * 60 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'Bookings open up to 30 days ahead');
  }
  // Cash on delivery is ASAP-only (start ≈ now + 45 min); scheduled orders pay online.
  if (isCod && startAt.getTime() > now + 60 * 60 * 1000) {
    throw new HttpsError(
      'failed-precondition',
      'Cash on delivery is only for ASAP orders. Pay online to schedule a later slot.'
    );
  }
  const startIstHour = istHourFromMs(startAt.getTime());
  if (startIstHour < SERVICE_OPEN_HOUR_IST || startIstHour >= SERVICE_CLOSE_HOUR_IST) {
    throw new HttpsError(
      'failed-precondition',
      'We’re closed 12–6 AM. Schedule your dropoff from 6 AM onwards.'
    );
  }

  // Server-side reprice for product lines
  let expectedSubtotal = 0;
  let extraControllers = 0;
  for (const line of cart) {
    if (line.experienceId && !line.productId) {
      const expSnap = await db.collection('experiences').doc(line.experienceId).get();
      if (!expSnap.exists) {
        throw new HttpsError('not-found', `Combo ${line.name || line.experienceId} not found`);
      }
      const expData = expSnap.data()!;
      // Combos rarely carry their own add-on pricing, so the consoles inside them are
      // what make an extra controller available — and priced — on the combo.
      const comboProducts: { id: string; addons?: FnAddon[] }[] = [];
      for (const pid of (expData?.productIds ?? []) as string[]) {
        const inner = (await db.collection('products').doc(pid).get()).data();
        comboProducts.push({ id: pid, addons: (inner?.addons ?? []) as FnAddon[] });
        assertLaunched(startAt.getTime(), inner?.availableFrom, String(inner?.shortName || inner?.name || pid));
      }
      const plans = (expData?.plans ?? []) as { id?: string; hours?: number; price?: number }[];
      const expAddons = experienceAddonOptions(
        {
          addons: (expData?.addons ?? []) as FnAddon[],
          productIds: (expData?.productIds ?? []) as string[],
        },
        comboProducts
      );
      const lineHours = line.hours ?? 12;
      let expectedAddons = 0;
      for (const a of line.addons ?? []) {
        const addon = expAddons.find((x) => x.id === a.id);
        if (!addon) {
          throw new HttpsError(
            'failed-precondition',
            `Extra ${a.name || a.id} is not offered on ${line.name || line.experienceId}`
          );
        }
        if (a.quantity > addon.maxQuantity) {
          throw new HttpsError(
            'failed-precondition',
            `Only ${addon.maxQuantity}× ${addon.name} allowed`
          );
        }
        if (isControllerAddonLike(addon)) extraControllers += a.quantity * (line.quantity || 1);
        expectedAddons += priceForAddon(addon, lineHours, a.quantity);
      }
      if (plans.length) {
        const plan =
          plans.find((p) => p.id && p.id === line.planId) ??
          plans.find((p) => p.hours === line.hours);
        const expected = (Number(plan?.price) || 0) * (line.quantity || 1) + expectedAddons * (line.quantity || 1);
        if (!plan || Math.abs(lineClientTotal(line) - expected) > 1) {
          throw new HttpsError(
            'failed-precondition',
            `Price mismatch for ${line.name || line.experienceId}`
          );
        }
      } else if (Math.abs(lineClientTotal(line) - (line.unitPrice * (line.quantity || 1) + expectedAddons * (line.quantity || 1))) > 1) {
        throw new HttpsError(
          'failed-precondition',
          `Price mismatch for ${line.name || line.experienceId}`
        );
      }
      expectedSubtotal += lineClientTotal(line);
      continue;
    }
    if (!line.productId) {
      throw new HttpsError('invalid-argument', 'Cart line missing productId');
    }
    const snap = await db.collection('products').doc(line.productId).get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `Product ${line.productId} not found`);
    }
    const product = snap.data() as FnProduct & { availableFrom?: string; shortName?: string };
    assertLaunched(startAt.getTime(), product.availableFrom, product.shortName || line.name || line.productId);
    for (const a of line.addons ?? []) {
      const addon = (product.addons ?? []).find((x) => x.id === a.id);
      if (!addon) continue;
      if (a.quantity > addon.maxQuantity) {
        throw new HttpsError('failed-precondition', `Only ${addon.maxQuantity}× ${addon.name} allowed per kit`);
      }
      if (isControllerAddonLike(addon)) extraControllers += a.quantity * (line.quantity || 1);
    }
    const expected = expectedLineTotal(productForStart(product, startAt.getTime()), line);
    const client = lineClientTotal(line);
    if (Math.abs(expected - client) > 1) {
      throw new HttpsError(
        'failed-precondition',
        `Price mismatch for ${line.name || line.productId}: expected ₹${expected}, got ₹${client}`
      );
    }
    expectedSubtotal += expected;
  }
  if (typeof subtotal === 'number' && Math.abs(expectedSubtotal - subtotal) > 1) {
    throw new HttpsError(
      'failed-precondition',
      `Cart subtotal mismatch: expected ₹${expectedSubtotal}, got ₹${subtotal}`
    );
  }

  const dropoff = validLatLng(dropoffLatInput, dropoffLngInput);
  if (!dropoff) {
    throw new HttpsError(
      'failed-precondition',
      'Pin this address on the map so we can work out the delivery charge.'
    );
  }
  const delivery = await deliveryQuoteFor(hubId, dropoff);
  // The 15 km limit is by road (straight line is only the fallback when Routes is down).
  if (delivery.km > SERVICE_RADIUS_KM) {
    throw new HttpsError('failed-precondition', OUT_OF_AREA_ERROR);
  }
  const expectedTaxes = 0;
  const expectedTotal = expectedSubtotal + expectedTaxes + delivery.fee;
  if (typeof total === 'number' && Math.abs(expectedTotal - total) > 1) {
    throw new HttpsError(
      'failed-precondition',
      `Delivery charge is now ₹${delivery.fee} (${delivery.km} km) — review your total of ₹${expectedTotal}.`
    );
  }

  const maxHours = Math.max(...cart.map((c) => cartItemHours(c)));
  const endAt = new Date(startAt.getTime() + maxHours * 60 * 60 * 1000);
  if (!rentalWindowAllowed(startAt.getTime(), maxHours)) {
    throw new HttpsError(
      'failed-precondition',
      startIstHour >= NIGHT_START_HOUR_IST
        ? `After 6 PM you can only book up to ${NIGHT_MAX_HOURS}h. Pick a shorter plan or an earlier slot.`
        : `This ${maxHours}h rental isn’t available for that start. Pick an earlier slot or a plan up to ${NIGHT_MAX_HOURS}h after 6 PM.`
    );
  }
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  const holdExpiresAt = new Date(now + HOLD_TTL_MS).toISOString();
  const startIso = startAt.toISOString();
  const endIso = endAt.toISOString();
  const nowIso = new Date().toISOString();

  // Expand combo/experience lines into product inventory holds
  const productLines: CartItem[] = [];
  for (const line of cart) {
    if (line.productId) {
      productLines.push(line);
      continue;
    }
    if (line.experienceId) {
      const expSnap = await db.collection('experiences').doc(line.experienceId).get();
      const productIds: string[] = expSnap.exists
        ? ((expSnap.data()?.productIds as string[]) ?? [])
        : [];
      if (!productIds.length) {
        throw new HttpsError(
          'failed-precondition',
          `Combo ${line.name} has no linked products for inventory`
        );
      }
      for (const productId of productIds) {
        productLines.push({ ...line, productId, quantity: line.quantity || 1 });
      }
    }
  }

  const unitAssignments: { productId: string; unitId: string }[] = [];

  for (const line of productLines) {
    const unitIds = await pickUnitsForProduct(
      line.productId!,
      hubId,
      line.quantity,
      startMs,
      endMs,
      now,
      line.inventoryUnitId ? [line.inventoryUnitId] : []
    );
    for (const unitId of unitIds) {
      unitAssignments.push({ productId: line.productId!, unitId });
    }
  }

  // Re-check inside a batch write for race safety (second pass)
  for (const a of unitAssignments) {
    const busy = await unitHasOverlap(a.unitId, startMs, endMs, Date.now());
    if (busy) {
      throw new HttpsError('aborted', 'Inventory changed — retry checkout');
    }
  }
  await assertControllersFree(extraControllers, startMs, endMs, now);

  const id = orderId();
  const reservationIds: string[] = [];
  const batch = db.batch();
  if (extraControllers > 0) {
    const resRef = db.collection('inventory_reservations').doc();
    reservationIds.push(resRef.id);
    batch.set(resRef, {
      id: resRef.id,
      kind: 'controllers',
      quantity: extraControllers,
      hubId,
      orderId: id,
      userId: uid,
      startAt: startIso,
      endAt: endIso,
      status: isCod ? 'confirmed' : 'hold',
      holdExpiresAt: isCod ? null : holdExpiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  for (const a of unitAssignments) {
    const resRef = db.collection('inventory_reservations').doc();
    reservationIds.push(resRef.id);
    batch.set(resRef, {
      id: resRef.id,
      inventoryUnitId: a.unitId,
      productId: a.productId,
      hubId,
      orderId: id,
      userId: uid,
      startAt: startIso,
      endAt: endIso,
      // COD is confirmed up front, so its units are never on a 15-min hold.
      status: isCod ? 'confirmed' : 'hold',
      holdExpiresAt: isCod ? null : holdExpiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  // Rider needs a name and number at the door, not just a street address.
  const customerContact = await resolveCustomerContact(
    uid,
    typeof addressId === 'string' ? addressId : undefined,
    addressFull
  );

  const order = {
    id,
    userId: uid,
    hubId,
    status: isCod ? ('confirmed' as const) : ('pending_payment' as const),
    paymentStatus: isCod ? ('cod' as const) : ('pending' as const),
    createdAt: nowIso,
    updatedAt: nowIso,
    holdExpiresAt: isCod ? null : holdExpiresAt,
    startAt: startIso,
    endAt: endIso,
    reservationIds,
    etaLabel: isCod
      ? startAt.getTime() - now > 3 * 60 * 60 * 1000
        ? 'Scheduled dropoff'
        : 'Arriving soon — pay on delivery'
      : startAt.getTime() - now > 3 * 60 * 60 * 1000
        ? 'Scheduled dropoff'
        : 'Complete payment to confirm',
    addressLabel,
    addressFull,
    ...(typeof addressId === 'string' ? { addressId } : {}),
    ...customerContact,
    items: cart.map((c) => ({
      productId: c.productId ?? null,
      experienceId: c.experienceId ?? null,
      name: c.name,
      image: c.image,
      durationLabel: c.durationLabel,
      returnLabel: `Returns ${formatInIndia(endAt)}`,
      price: lineClientTotal(c),
      badges: [...(c.includesNote ? [c.includesNote.slice(0, 28)] : [])],
      extras: (c.addons ?? [])
        .filter((a) => a.quantity > 0)
        .map((a) => `${a.quantity}× ${a.name} · ₹${a.unitPrice} each`),
    })),
    subtotal: expectedSubtotal,
    taxes: expectedTaxes,
    deliveryFee: delivery.fee,
    deliveryKm: delivery.km,
    deliveryDistanceMethod: delivery.method,
    total: expectedTotal,
    termsVersion: LEGAL_VERSION,
    termsAcceptedAt: nowIso,
    paymentMethodLabel,
    progressPercent: isCod ? 20 : 10,
    setupIncluded: true,
    liveDispatch: false,
    riderId: null,
    ...(isCod ? { paymentProvider: 'cod' as const } : {}),
    // Exact delivery pin from the saved address (Zepto-style) — rider
    // navigates to these coords instead of a fuzzy text search.
    dropoffLat: dropoff.lat,
    dropoffLng: dropoff.lng,
    // 4-digit handover code — customer reads it to the rider before mark-delivered.
    deliveryOtp: String(Math.floor(1000 + Math.random() * 9000)),
    // Pickup code lives in orders/{id}/private/codes (customer-only); the rider enters it to close.
    pickupOtpRequired: true,
  };

  batch.set(db.collection('orders').doc(id), order);
  batch.set(db.collection('orders').doc(id).collection('private').doc('codes'), {
    pickupOtp: String(randomInt(1000, 10000)),
    createdAt: nowIso,
  });
  batch.set(
    db.collection('users').doc(uid),
    { legalAcceptance: { version: LEGAL_VERSION, acceptedAt: nowIso, orderId: id } },
    { merge: true }
  );
  await batch.commit();

  await pushNotification(uid, {
    title: isCod ? 'Order confirmed' : 'Booking held',
    body: isCod
      ? `${id} is confirmed — pay ₹${expectedTotal} when your kit is handed over.`
      : `${id} is reserved for 15 minutes — complete payment to confirm.`,
    type: 'order',
    orderId: id,
  });

  // A COD order is dispatchable the moment it exists, so riders must hear about it
  // rather than discovering it on their next refresh. Online orders are broadcast
  // once payment confirms (confirmPayment).
  if (isCod) {
    await notifyHubRiders(hubId, {
      title: 'New run available',
      body: `${id} · ${runSummary(order)} · cash on delivery`,
      type: 'delivery',
      orderId: id,
    });
  }

  // Ops awareness: an order that nobody knows about is the same as no order. The
  // slot time is spelled out ("starts 15 Nov, 12:00 pm") because a scheduled run
  // booked for tomorrow is exactly the kind that gets missed.
  await notifyOps({
    kind: isCod ? 'dispatch' : 'new_order',
    severity: isCod ? 'info' : 'warning',
    title: isCod ? `New COD order: ${id}` : `New order: ${id}`,
    body: `${id} · ${addressLabel} · ₹${expectedTotal} · ${isCod ? 'cash on delivery' : 'awaiting payment'} · starts ${formatInIndia(startAt)}`,
    orderId: id,
  });

  return { orderId: id, order, holdExpiresAt: isCod ? null : holdExpiresAt };
});

// ——— confirmPayment ———

export const confirmPayment = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, fail, provider = 'demo', payment } = request.data as {
    orderId: string;
    fail?: boolean;
    provider?: 'demo' | 'razorpay';
    payment?: { razorpayOrderId?: string; paymentId?: string; signature?: string };
  };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');
  const gatewayLive = Boolean(razorpayKeySecret.value());

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;
  if (order.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');

  if (fail) {
    if (order.paymentStatus === 'paid') return { ok: true, paymentStatus: 'paid' as const };
    await markOrderPaymentFailedOrCancelled(ref, order, 'Payment failed');
    await pushNotification(uid, {
      title: 'Payment failed',
      body: `${id} was not paid. Inventory hold released.`,
      type: 'payment',
      orderId: id,
    });
    return { ok: false, paymentStatus: 'failed' as const, error: 'Payment could not be completed' };
  }

  if (order.paymentStatus === 'paid') {
    return { ok: true, paymentStatus: 'paid' as const };
  }

  const nowIso = new Date().toISOString();
  let paymentId: string;
  if (gatewayLive) {
    // With Razorpay configured, only Razorpay's signed proof can mark an order paid.
    // Verify proof FIRST — never cancel a hold after the customer already paid.
    if (provider !== 'razorpay' || !payment?.razorpayOrderId || !payment.paymentId || !payment.signature) {
      const holdExp = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() : 0;
      if (holdExp && holdExp < Date.now() && order.paymentStatus === 'pending') {
        await markOrderPaymentFailedOrCancelled(ref, order, 'Hold expired');
        throw new HttpsError('deadline-exceeded', 'Payment hold expired — start checkout again');
      }
      throw new HttpsError('invalid-argument', 'Payment proof required');
    }
    if (!order.razorpayOrderId || payment.razorpayOrderId !== order.razorpayOrderId) {
      throw new HttpsError('permission-denied', 'Payment does not belong to this order');
    }
    if (!validRazorpaySignature(payment.razorpayOrderId, payment.paymentId, payment.signature)) {
      throw new HttpsError('permission-denied', 'Payment could not be verified');
    }
    const payRef = db.collection('payments').doc(payment.razorpayOrderId);
    const pay = (await payRef.get()).data();
    if (!pay || pay.orderId !== id || Math.round(Number(pay.amount) || 0) !== Math.round(Number(order.total) || 0)) {
      throw new HttpsError('failed-precondition', 'Payment amount does not match this order');
    }
    paymentId = payment.paymentId;
    await payRef.update({ status: 'paid', providerRef: paymentId, updatedAt: nowIso });
  } else {
    const holdExp = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() : 0;
    if (holdExp && holdExp < Date.now() && order.paymentStatus === 'pending') {
      await markOrderPaymentFailedOrCancelled(ref, order, 'Hold expired');
      throw new HttpsError('deadline-exceeded', 'Payment hold expired — start checkout again');
    }
    // No gateway keys (local/dev builds only): demo checkout.
    paymentId = `demo_${randomBytes(6).toString('hex')}`;
    await db.collection('payments').doc(paymentId).set({
      id: paymentId,
      orderId: id,
      userId: uid,
      amount: order.total,
      currency: 'INR',
      provider: 'demo',
      providerRef: paymentId,
      status: 'paid',
      createdAt: nowIso,
    });
  }

  const reservationIds: string[] = order.reservationIds ?? [];
  await Promise.all(
    reservationIds.map((rid) =>
      db.collection('inventory_reservations').doc(rid).update({
        status: 'confirmed',
        holdExpiresAt: null,
        updatedAt: nowIso,
      })
    )
  );

  await ref.update({
    paymentStatus: 'paid',
    status: 'confirmed',
    holdExpiresAt: null,
    progressPercent: 20,
    updatedAt: nowIso,
    ...(gatewayLive
      ? { paymentProvider: 'razorpay', paymentMethodLabel: 'Razorpay', razorpayPaymentId: paymentId }
      : { paymentMethodLabel: '', paymentProvider: 'demo' }),
  });

  await clearUserCart(uid);

  await pushNotification(uid, {
    title: 'Payment received',
    body: `${id} is confirmed and being packed.`,
    type: 'payment',
    orderId: id,
  });

  // Paid and unassigned: put it in front of every rider in the hub.
  await notifyHubRiders(order.hubId, {
    title: 'New run available',
    body: `${id} · ${runSummary(order)} · paid`,
    type: 'delivery',
    orderId: id,
  });

  // Money in the bank is the moment ops must know, not the moment the order was made.
  await notifyOps({
    kind: 'payment_received',
    severity: 'warning',
    title: `Paid booking: ${id}`,
    body: `${id} · ₹${Math.round(Number(order.total) || 0)} · ${runSummary(order)} · starts ${formatInIndia(new Date(order.startAt))}`,
    orderId: id,
  });

  return { ok: true, paymentStatus: 'paid' as const };
});

/** @deprecated Prefer confirmPayment */
export const confirmPaymentDemo = confirmPayment;

// ——— cancelBooking ———

export const cancelBooking = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, reason } = request.data as { orderId: string; reason?: string };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;
  if (order.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');
  if (['cancelled', 'completed', 'refunded'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'Order already closed');
  }
  // Self-service cancellation closes the moment a rider accepts the run.
  if (order.riderId) {
    throw new HttpsError(
      'failed-precondition',
      'A delivery partner is already assigned — this order can no longer be cancelled'
    );
  }
  if (!['pending_payment', 'confirmed', 'preparing'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'This order can no longer be cancelled');
  }

  const refundResult = order.paymentStatus === 'paid'
    ? await executeRefundInternal(ref, order, 'customer', reason)
    : null;

  await releaseReservations(order.reservationIds ?? [], 'released');
  await ref.update({
    status: 'cancelled',
    paymentStatus: order.paymentStatus === 'paid' ? 'refunded' : order.paymentStatus,
    holdExpiresAt: null,
    progressPercent: 0,
    cancelReason: reason ?? null,
    cancelledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const refundedAmount =
    refundResult?.record?.amount ??
    (order.paymentStatus === 'paid' ? Math.round(Number(order.total) || 0) : 0);
  const refundStatusLine =
    order.paymentStatus === 'cod'
      ? 'Nothing was charged.'
      : order.paymentStatus === 'paid'
        ? refundResult?.manual
          ? 'Refund recorded for ops to process.'
          : refundResult?.record?.status === 'processed'
            ? `Refund of ₹${refundedAmount} processed.`
            : refundResult?.record?.error
              ? `Refund could not be completed: ${refundResult.record.error}`
              : `Refund of ₹${refundedAmount} requested.`
        : 'No payment on this order.';

  await pushNotification(uid, {
    title: 'Order cancelled',
    body: `${id} was cancelled. ${refundStatusLine}`,
    type: 'order',
    orderId: id,
  });

  return { ok: true, refunded: refundResult?.refunded ?? false, manual: refundResult?.manual ?? false };
});

/**
 * Server refund execution — the callable both the customer cancel path and the
 * staff refund action use. Eligibility is checked server-side so a customer cannot
 * refund an order they do not own, and a staff action can refund orders a rider
 * already accepted (where the customer cancel screen is blocked).
 *
 * For paid Razorpay orders with a captured payment, this calls Razorpay refunds.
 * Today (demo / no gateway keys) it records the refund state and leaves the money
 * movement to ops — the app then shows an honest message instead of a fake timeline.
 */
export const executeRefundBooking = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const isAdmin = request.auth?.token?.admin === true;
  const { orderId: id, reason, staffNote } = request.data as {
    orderId: string;
    reason?: string;
    staffNote?: string;
  };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;

  // Staff may refund any order they can see. Customers may only refund their own.
  if (!isAdmin && order.userId !== uid) {
    throw new HttpsError('permission-denied', 'Not your order');
  }
  if (!isAdmin && !order.customerPhone && !order.userId) {
    throw new HttpsError('permission-denied', 'This order has no customer on file');
  }

  // Closed orders cannot be refunded again.
  if (['cancelled', 'completed', 'refunded'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'Order is already closed');
  }

  // Only paid orders have money to move back.
  if (order.paymentStatus !== 'paid') {
    throw new HttpsError(
      'failed-precondition',
      order.paymentStatus === 'cod'
        ? 'This order was cash on delivery — there is nothing to refund.'
        : 'This order has not been paid yet.'
    );
  }

  if (order.refundProcessed) {
    throw new HttpsError('already-exists', 'A refund has already been processed for this order');
  }

  const result = await executeRefundInternal(ref, order, isAdmin ? 'staff' : 'customer', reason, staffNote);
  if (!result.refunded && result.record?.status === 'failed') {
    throw new HttpsError('internal', result.record.error ?? 'Refund could not be completed');
  }
  if (!result.refunded && result.inFlight) {
    throw new HttpsError('aborted', 'A refund is already in progress for this order');
  }

  return {
    ok: true,
    refunded: result.refunded,
    manual: result.manual,
    gatewayUsed: result.gatewayUsed,
    record: result.record as RefundRecord | null,
  };
});

/**
 * Reconcile an order against its scheduled slot and the real inventory state.
 * Used by the pre-slot availability recheck so ops get warned before the customer’s
 * scheduled prepaid slot arrives — not after.
 *
 * Returns the kind of action that would be appropriate if the order were reviewed
 * right now. It does not mutate the order (except for the recheck flag when a
 * problem is found), so the recheck is a read-heavy diagnostic, not a cancellation.
 */
async function recheckScheduledOrder(orderRef: DocumentReference, order: DocumentData): Promise<{
  slotStartMs: number;
  elapsedMs: number;
  nowMs: number;
  status: 'ok' | 'unfulfillable' | 'noStock';
  note: string;
}> {
  const nowMs = Date.now();
  const startMs = order.startAt ? new Date(order.startAt).getTime() : NaN;
  const slotStartMs = Number.isFinite(startMs) ? startMs : NaN;
  const elapsedMs = Number.isFinite(slotStartMs) ? slotStartMs - nowMs : NaN;

  // COD / unpaid orders are not in scope for the pre-slot refund risk check.
  if (order.paymentStatus === 'cod' || order.paymentStatus !== 'paid') {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'ok',
      note: 'Not a paid scheduled order — out of scope for the pre-slot recheck.',
    };
  }

  // Orders that have already moved past their slot are not a future risk.
  if (!Number.isFinite(slotStartMs) || slotStartMs <= nowMs) {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'ok',
      note: 'Slot has already started or passed — recheck is for future slots only.',
    };
  }

  // No reserved kits = nothing to recheck (legacy / pathological doc).
  const reservationIds = (order.reservationIds ?? []) as string[];
  if (!reservationIds.length) {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'ok',
      note: 'No inventory reservations on this order — nothing to recheck.',
    };
  }

  // For scheduled slots that are still some time out, only flag orders that are
  // close enough to matter (within ~24h of the slot), so the recheck is not noisy
  // for far-future bookings that still have time to be rescued by ops.
  const nearThresholdMs = 24 * 60 * 60 * 1000;
  if (Number.isFinite(elapsedMs) && elapsedMs > nearThresholdMs) {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'ok',
      note: `Slot is in the future (~${Math.round(elapsedMs / 3600000)}h away) — recheck again closer to the slot.`,
    };
  }

  // Walk each reserved kit/unit and decide whether it is still realistically
  // available for this slot. A unit is unfulfillable when its holding reservation
  // has been released/completed, or when the unit is no longer available, or when
  // the unit genuinely cannot be booked for this window.
  const problems: string[] = [];
  let unfulfillableCount = 0;
  let releasedCount = 0;

  for (const rid of reservationIds) {
    const rSnap = await db.collection('inventory_reservations').doc(rid).get();
    if (!rSnap.exists) {
      problems.push(`reservation ${rid} no longer exists`);
      unfulfillableCount++;
      continue;
    }
    const r = rSnap.data()!;

    if (r.status === 'released' || r.status === 'completed') {
      releasedCount++;
      continue;
    }

    if (r.status === 'hold' && r.holdExpiresAt) {
      const holdExp = new Date(r.holdExpiresAt).getTime();
      if (!Number.isFinite(holdExp) || holdExp < nowMs) {
        // Expired hold = the unit was never confirmed and is now free again.
        releasedCount++;
        continue;
      }
    }

    if (r.status !== 'confirmed' && r.status !== 'hold') {
      problems.push(`reservation ${rid} is in state ${r.status}`);
      unfulfillableCount++;
      continue;
    }

    if (r.inventoryUnitId) {
      const unitSnap = await db.collection('inventory_units').doc(r.inventoryUnitId).get();
      if (!unitSnap.exists) {
        problems.push(`unit ${r.inventoryUnitId} no longer exists`);
        unfulfillableCount++;
      } else if (unitSnap.data()?.status !== 'available') {
        problems.push(`unit ${r.inventoryUnitId} is no longer available`);
        unfulfillableCount++;
      }
    }
  }

  if (unfulfillableCount > 0) {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'unfulfillable',
      note: `Can’t fulfil this slot: ${unfulfillableCount} reserved unit${unfulfillableCount === 1 ? '' : 's'} are no longer available, and ${releasedCount} reservation${releasedCount === 1 ? '' : 's'} were already released. ${problems.slice(0, 1).join('. ')}`,
    };
  }

  if (releasedCount > 0) {
    return {
      slotStartMs,
      elapsedMs,
      nowMs,
      status: 'noStock',
      note: `${releasedCount} reservation${releasedCount === 1 ? '' : 's'} were released and the slot is within ~24h — confirm stock before the slot or move the customer to a different time / refund.`,
    };
  }

  return {
    slotStartMs,
    elapsedMs,
    nowMs,
    status: 'ok',
    note: 'Reserved stock still looks available for the slot.',
  };
}

/**
 * Pre-slot availability recheck for scheduled prepaid orders.
 *
 * Runs on a light schedule and re-reads the reserved kits for paid scheduled orders
 * whose slot is still in the future. When a slot can’t be fulfilled (unit gone,
 * reservation released, etc.), it sets a recheck flag and a staff note on the order
 * so ops can act — reschedule, swap the unit, or refund the customer — before the
 * customer’s slot arrives.
 *
 * This is intentionally a diagnostic + flag, not an auto-cancel. The refund path
 * (executeRefundBooking) is what actually moves the money once ops decide to cancel.
 */
// NOTE: named recheckPrepaidSlots rather than recheckScheduledPrepaidSlots — that
// resource wedged on the control plane (update 409s, scheduler job never created).
async function recheckPrepaidSlotsInternal() {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // Paid scheduled orders whose slot is still ahead — the population we care about.
    const snap = await db
      .collection('orders')
      .where('status', 'in', ['pending_payment', 'confirmed', 'preparing'])
      .where('paymentStatus', '==', 'paid')
      .where('startAt', '>', nowIso)
      .where('riderId', '==', null)
      .limit(200)
      .get();

    if (snap.empty) {
      logger.info('Pre-slot recheck: no scheduled paid orders pending');
      return;
    }

    let checked = 0;
    let flagged = 0;

    for (const doc of snap.docs) {
      checked++;
      const order = doc.data();
      const result = await recheckScheduledOrder(doc.ref, order);

      // Nothing to do for orders that are still fine.
      if (result.status === 'ok') continue;

      // Mark the order so ops can find these quickly (e.g. a future filter or
      // report). Do not change the order’s main status here.
      // Store only the problem states — `ok` is the un-stored default.
      await doc.ref.update({
        preSlotRecheckAt: nowIso,
        preSlotRecheckStatus: result.status as 'unfulfillable' | 'noStock' | null,
        preSlotRecheckNote: result.note,
        updatedAt: nowIso,
      });

      // Also send the customer a heads-up when the slot is at risk, so they are not
      // surprised at delivery time. Keep it brief and actionable.
      if (order.userId) {
        const hoursAway = Math.round(result.elapsedMs / 3600000);
        await pushNotification(order.userId, {
          title: 'Booking update',
          body: `${doc.id}: we’re checking your slot ${hoursAway > 0 ? `in about ${hoursAway} hour${hoursAway === 1 ? '' : 's'}` : 'soon'} — we’ll be in touch if anything changes.`,
          type: 'order',
          orderId: doc.id,
        }).catch(() => undefined);
      }

      flagged++;
      logger.warn('Pre-slot recheck flagged an order', {
        orderId: doc.id,
        status: result.status,
        note: result.note,
        slotStartMs: result.slotStartMs,
        elapsedMs: result.elapsedMs,
      });
    }

    logger.info('Pre-slot recheck completed', { checked, flagged, nowMs });
}

export const recheckPrepaidSlots = onSchedule(
  { region: REGION, schedule: 'every 15 minutes' },
  async () => {
    await recheckPrepaidSlotsInternal();
  }
);


// ——— collectCodPayment ———

/** Assigned rider records cash/UPI taken at handover so COD orders settle. */
export const collectCodPayment = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id } = request.data as { orderId: string };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;

  const isAdmin = request.auth?.token?.admin === true;
  if (!isAdmin && order.riderId !== uid) {
    throw new HttpsError('permission-denied', 'Only the assigned rider can record this payment');
  }
  if (order.paymentStatus === 'paid') return { ok: true, already: true };
  if (order.paymentStatus !== 'cod') {
    throw new HttpsError('failed-precondition', 'This order is not cash on delivery');
  }
  if (!['delivered', 'active', 'returning', 'completed'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'Collect cash after the kit is handed over');
  }

  const nowIso = new Date().toISOString();
  const paymentId = `cod_${randomBytes(6).toString('hex')}`;
  await db.collection('payments').doc(paymentId).set({
    id: paymentId,
    orderId: id,
    userId: order.userId ?? null,
    amount: order.total ?? 0,
    currency: 'INR',
    provider: 'cod',
    providerRef: paymentId,
    status: 'paid',
    kind: 'cod',
    collectedBy: uid,
    createdAt: nowIso,
  });

  await ref.update({
    paymentStatus: 'paid',
    paymentProvider: 'cod',
    paymentMethodLabel: 'Cash on Delivery',
    codCollectedAt: nowIso,
    codCollectedBy: uid,
    updatedAt: nowIso,
  });

  if (order.userId) {
    await pushNotification(order.userId, {
      title: 'Payment received',
      body: `${id}: ₹${Math.round(Number(order.total) || 0)} cash collected by your rider.`,
      type: 'payment',
      orderId: id,
    });
  }

  return { ok: true };
});

// ——— updateOrderStatus ———

export const updateOrderStatus = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, status } = request.data as { orderId: string; status: string };
  if (!id || !status) throw new HttpsError('invalid-argument', 'orderId and status required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;

  const isAdmin = request.auth?.token?.admin === true;
  if (!isAdmin && order.userId !== uid) {
    throw new HttpsError('permission-denied', 'Not allowed');
  }

  // Delivery progress belongs to riders and ops; customers only watch it.
  if (!isAdmin) {
    throw new HttpsError('permission-denied', 'Only ops can set this status');
  }

  const from = order.status as string;
  const next = ORDER_TRANSITIONS[from] ?? [];
  if (!next.includes(status)) {
    throw new HttpsError('failed-precondition', `Cannot transition ${from} → ${status}`);
  }
  const settled = order.paymentStatus === 'paid' || order.paymentStatus === 'cod';
  if (!settled && !['cancelled', 'refunded'].includes(status)) {
    throw new HttpsError('failed-precondition', 'Order is not paid');
  }

  const progress: Record<string, number> = {
    preparing: 35,
    out_for_delivery: 55,
    delivered: 70,
    active: 85,
    returning: 92,
    completed: 100,
  };

  await ref.update({
    status,
    progressPercent: progress[status] ?? order.progressPercent,
    updatedAt: new Date().toISOString(),
  });

  // Closing an order must always free its kits — otherwise confirmed
  // reservations block the units forever (the orphan leak).
  if (status === 'completed') {
    await releaseReservations(order.reservationIds ?? [], 'completed');
  }

  return { ok: true, status };
});

// ——— onOrderHandedOver ———

const timeFmtIst = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/**
 * The rental clock starts at handover, not at booking: when an order turns
 * "delivered" (rider app or ops), slide startAt/endAt — and the unit
 * reservations — to start now, keeping the booked length. Never earlier than
 * the booked start, so an early scheduled drop-off doesn't eat into their slot.
 */
// NOTE: named onOrderHandedOver rather than onOrderDelivered — that resource name
// wedged on Google's control plane (update 409s) and had to be abandoned, the same
// failure that forced claimRun's name.
export const onOrderHandedOver = onDocumentUpdated(
  { document: 'orders/{orderId}', region: REGION },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || !event.data) return;

    // Rider alerts ride along on this trigger so a run can never be assigned or
    // cancelled without the rider being told. They run before the handover guard
    // below, which returns early for every other kind of update.
    const riderId = typeof after.riderId === 'string' ? after.riderId : null;
    if (riderId && riderId !== before.riderId) {
      // claimRun sets riderAcceptedAt in the same write; ops assignment does not.
      const acceptedByRider = after.riderAcceptedAt !== before.riderAcceptedAt;
      if (!acceptedByRider) {
        await notifyRider(riderId, {
          title: 'Run assigned to you',
          body: `${event.params.orderId} · ${runSummary(after)} — open My runs to start.`,
          type: 'delivery',
          orderId: event.params.orderId,
        });
      }
    }
    if (
      riderId &&
      after.status !== before.status &&
      ['cancelled', 'refunded'].includes(String(after.status))
    ) {
      await notifyRider(riderId, {
        title: 'Run cancelled',
        body: `${event.params.orderId} was cancelled${after.cancelReason ? ` — ${after.cancelReason}` : ''}. Do not deliver it.`,
        type: 'delivery',
        orderId: event.params.orderId,
      });
    }
    // Handover can land the order on "delivered" (ops) or straight on "active" (the
    // rider verifies the door code once). Both start the rental clock.
    const handedOver =
      (after.status === 'delivered' && before.status !== 'delivered') ||
      (after.status === 'active' && before.status !== 'active');
    if (!handedOver || after.deliveredAt) return;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // The customer's originally booked window must always be preserved, even when
    // handover happens late. We never want the system to silently pretend the slot
    // is still valid when it isn't.
    const bookedStartMs = after.bookedStartAt ? new Date(after.bookedStartAt).getTime() : NaN;
    const bookedEndMs = after.bookedEndAt ? new Date(after.bookedEndAt).getTime() : NaN;
    const startAtMs = new Date(after.startAt).getTime();
    const endAtMs = new Date(after.endAt).getTime();

    const hasRuntimeWindow =
      Number.isFinite(startAtMs) && Number.isFinite(endAtMs) && endAtMs > startAtMs;

    if (!hasRuntimeWindow) {
      await event.data.after.ref.update({ deliveredAt: nowIso });
      return;
    }

    // If we already have a preserved booked window, use it. Otherwise seed it from
    // the current startAt/endAt (legacy orders).
    const effectiveBookedStartMs =
      Number.isFinite(bookedStartMs) ? bookedStartMs : startAtMs;
    const effectiveBookedEndMs = Number.isFinite(bookedEndMs) ? bookedEndMs : endAtMs;

    // Real handover time is now. The rental clock starts at handover, but we keep the
    // booked window as the customer-facing truth.
    const handoverStartMs = Math.max(nowMs, effectiveBookedStartMs);
    const handoverEndMs = handoverStartMs + (effectiveBookedEndMs - effectiveBookedStartMs);

    const lateDelivery =
      Number.isFinite(effectiveBookedEndMs) && nowMs > effectiveBookedEndMs + 30 * 60 * 1000;

    const patch: Record<string, unknown> = {
      deliveredAt: nowIso,
      bookedStartAt: new Date(effectiveBookedStartMs).toISOString(),
      bookedEndAt: new Date(effectiveBookedEndMs).toISOString(),
      updatedAt: nowIso,
    };

    if (lateDelivery) {
      patch.lateDeliveredAt = nowIso;
      patch.lateMinutes =
        Math.round((nowMs - effectiveBookedEndMs) / 60000) ?? undefined;
      patch.lateReason =
        'Delivery happened after the booked end time';
    }

    await event.data.after.ref.update(patch);

    // Only shift the unit reservations if handover is at/after the booked start.
    // If for some reason handover is before the booked start (early dropoff), keep
    // the booked window for the units too.
    if (handoverStartMs >= effectiveBookedStartMs) {
      const startIso = new Date(handoverStartMs).toISOString();
      const endIso = new Date(handoverEndMs).toISOString();
      await Promise.all(
        ((after.reservationIds ?? []) as string[]).map((rid) =>
          db
            .collection('inventory_reservations')
            .doc(rid)
            .update({ startAt: startIso, endAt: endIso, updatedAt: nowIso })
            .catch((err) => logger.warn('reservation shift failed', { rid, err: String(err) }))
        )
      );
    }

    if (after.userId) {
      const hours = Math.round((handoverEndMs - handoverStartMs) / 3600000);
      const startedAt = timeFmtIst.format(new Date(handoverStartMs));
      const endsAt = timeFmtIst.format(new Date(handoverEndMs));
      const body = lateDelivery
        ? `${event.params.orderId}: your ${hours}h started late at ${startedAt} and ends at ${endsAt}.`
        : `${event.params.orderId}: your ${hours}h started at ${startedAt} and ends at ${endsAt}.`;
      await pushNotification(after.userId, {
        title: lateDelivery ? 'Your rental has started' : 'Your rental has started',
        body,
        type: 'order',
        orderId: event.params.orderId,
      });
    }
  }
);

// ——— completeReturn ———

/**
 * Closing an order is the rider's job (or ops): the assigned rider enters the
 * customer's pickup code at collection. Customers can never close their own order.
 */
export const completeReturn = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, otp } = request.data as { orderId: string; otp?: string };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;
  const riderSnap = await db.collection('riders').doc(uid).get();
  const isAssignedRider =
    riderSnap.exists && riderSnap.data()?.active === true && order.riderId === uid;
  const isAdmin = request.auth?.token?.admin === true;
  if (!isAdmin && !isAssignedRider) {
    throw new HttpsError('permission-denied', 'Only the delivery rider can complete this order');
  }
  if (order.status === 'completed') return { ok: true };
  if (!isAdmin) {
    if (order.status !== 'returning') {
      throw new HttpsError('failed-precondition', 'Start the return pickup before completing the order');
    }
    const codes = (await ref.collection('private').doc('codes').get()).data();
    const expected = String(codes?.pickupOtp ?? '').replace(/\D/g, '');
    if (expected && String(otp ?? '').replace(/\D/g, '') !== expected) {
      throw new HttpsError('permission-denied', 'Wrong pickup code — ask the customer for the 4-digit pickup code');
    }
  }

  await releaseReservations(order.reservationIds ?? [], 'completed');
  await ref.update({
    status: 'completed',
    progressPercent: 100,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await pushNotification(order.userId, {
    title: 'Return complete',
    body: `${id} is closed. Thanks for renting with PlayPort.`,
    type: 'order',
    orderId: id,
  });

  // Ops closing a run should not leave the rider thinking a pickup is still owed.
  if (order.riderId && order.riderId !== uid) {
    await notifyRider(order.riderId, {
      title: 'Run closed by ops',
      body: `${id} is completed — nothing left to collect.`,
      type: 'order',
      orderId: id,
    });
  }

  return { ok: true };
});

// ——— releaseExpiredInventoryHold ———

async function releaseExpiredHoldsInternal() {
  const nowIso = new Date().toISOString();
  const snap = await db
    .collection('inventory_reservations')
    .where('status', '==', 'hold')
    .where('holdExpiresAt', '<=', nowIso)
    .limit(200)
    .get();

  const orderIds = new Set<string>();
  for (const doc of snap.docs) {
    orderIds.add(doc.data().orderId as string);
    await doc.ref.update({
      status: 'released',
      holdExpiresAt: null,
      updatedAt: nowIso,
    });
  }

  let recovered = 0;
  let cancelled = 0;
  for (const oid of orderIds) {
    const orderRef = db.collection('orders').doc(oid);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) continue;
    const order = orderSnap.data()!;
    if (order.paymentStatus === 'paid') continue;
    if (order.paymentStatus !== 'pending') continue;

    // Money may already be in Razorpay while our hold timer ran out. Never cancel
    // a booking that the gateway already captured — resurrect it instead.
    const capturedId = await razorpayCapturedPaymentId(
      typeof order.razorpayOrderId === 'string' ? order.razorpayOrderId : null
    );
    if (capturedId) {
      await confirmPaidOrderAdmin(oid, capturedId);
      recovered += 1;
      continue;
    }

    await orderRef.update({
      status: 'cancelled',
      paymentStatus: 'failed',
      holdExpiresAt: null,
      progressPercent: 0,
      cancelReason: 'Payment hold expired',
      cancelledAt: nowIso,
      updatedAt: nowIso,
    });
    cancelled += 1;
    if (order.userId) {
      await pushNotification(order.userId, {
        title: 'Hold expired',
        body: `${oid} was released after payment timed out.`,
        type: 'order',
        orderId: oid,
      });
    }
    await notifyOps({
      kind: 'flag',
      severity: 'info',
      title: `Checkout abandoned: ${oid}`,
      body: `${oid} · ₹${Math.round(Number(order.total) || 0)} · hold expired without a Razorpay capture · ${runSummary(order)}`,
      orderId: oid,
    });
  }

  return { releasedReservations: snap.size, ordersTouched: orderIds.size, recovered, cancelled };
}

/**
 * Catch payments Razorpay captured after we cancelled the hold (or when the
 * webhook never arrived). Runs on the same 5-minute schedule as hold release.
 */
async function reconcilePendingRazorpayPaymentsInternal() {
  const snap = await db
    .collection('payments')
    .where('provider', '==', 'razorpay')
    .where('status', '==', 'pending')
    .limit(50)
    .get();

  let checked = 0;
  let recovered = 0;
  for (const doc of snap.docs) {
    checked += 1;
    const pay = doc.data();
    const orderId = typeof pay.orderId === 'string' ? pay.orderId : null;
    if (!orderId) continue;
    const capturedId = await razorpayCapturedPaymentId(doc.id);
    if (!capturedId) continue;
    await confirmPaidOrderAdmin(orderId, capturedId.startsWith('pay_') ? capturedId : doc.id);
    recovered += 1;
  }
  if (checked) logger.info('Razorpay pending reconcile', { checked, recovered });
  return { checked, recovered };
}

export const releaseExpiredInventoryHold = onCall({ region: REGION }, async (request) => {
  requireAuth(request.auth?.uid);
  return releaseExpiredHoldsInternal();
});

export const releaseExpiredInventoryHoldSchedule = onSchedule(
  { region: REGION, schedule: 'every 5 minutes' },
  async () => {
    const result = await releaseExpiredHoldsInternal();
    logger.info('Expired holds released', result);

    // This is the only schedule on the project with a working Cloud Scheduler
    // record. The dedicated jobs (expirePastSlotOrders, recheckPrepaidSlots,
    // backfillOrderContacts) were created during a control-plane wedge and never got
    // their scheduler records, so the maintenance they own runs from here instead.
    for (const [label, task] of [
      ['contact backfill', backfillOrderContactsInternal],
      ['past-slot expiry', expirePastSlotOrdersInternal],
      ['pre-slot recheck', recheckPrepaidSlotsInternal],
      ['razorpay reconcile', reconcilePendingRazorpayPaymentsInternal],
    ] as const) {
      try {
        await task();
      } catch (err) {
        // One failing task must never stop the others, and must never stop the
        // hold release above from having run.
        logger.error(`scheduled maintenance failed: ${label}`, { err: String(err) });
      }
    }
  }
);

// ——— expirePastSlotOrders ———

/**
 * Scheduled cleanup for orders that have been sitting visible and dispatchable
 * for too long without being accepted/dispatched. This is the direct fix for the
 * loophole where an order can stay visible indefinitely and still be accepted very
 * late (or never), even when its original slot has long passed.
 *
 * The rule of thumb:
 * - A paid order whose slot has passed and was never dispatched is no longer a
 *   real delivery; it gets flagged/expired so ops and the customer see the truth.
 * - An unpaid/pending order whose payment hold is long gone and whose slot is past
 *   should already have been cleaned up by releaseExpiredHoldsInternal; this job is
 *   a backstop for anything that slipped through or for orders that were confirmed
 *   but never dispatched.
 *
 * This does not delete orders. It moves them to a terminal/expired state and records
 * why, so the app can show "this order expired / was never dispatched" instead of
 * leaving it visible as if it were still live.
 */
// NOTE: named expirePastSlotOrders rather than expireStaleOrders — that resource
// name wedged on Google's control plane (eternal create 409s) and had to be
// abandoned, the same failure that forced claimRun's name.
async function expirePastSlotOrdersInternal() {
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    // Find orders that are still "alive" in the portal but should not be:
    // - confirmed/preparing orders that were never dispatched (no riderId) and whose
    //   slot is well past, or
    // - paid orders whose slot passed long enough ago that they're no longer realistic
    //   to dispatch for the original slot.
    const snap = await db
      .collection('orders')
      .where('status', 'in', ['pending_payment', 'confirmed', 'preparing'])
      .where('riderId', '==', null)
      .limit(200)
      .get();

    if (snap.empty) {
      logger.info('expirePastSlotOrders: no unaccepted orders');
      return;
    }

    let checked = 0;
    let expired = 0;
    let flagged = 0;

    for (const doc of snap.docs) {
      checked++;
      const order = doc.data();
      const startMs = order.startAt ? new Date(order.startAt).getTime() : NaN;

      // Skip pathological docs without a readable start.
      if (!Number.isFinite(startMs)) continue;

      // If the slot is still in the future, leave it alone.
      if (startMs > nowMs) continue;

      // Measure lateness from the *delivery slot*, not the rental window: gating on
      // endAt let a 24h rental sit visible for a whole day after its slot passed.
      const pastMs = nowMs - startMs;

      // Paid orders: if the slot is past and nobody dispatched, expire/flag it.
      // Unpaid/pending orders with past slots should already be gone; if they survive
      // here, treat them as expired too (backstop).
      const isPaid = order.paymentStatus === 'paid' || order.paymentStatus === 'cod';

      // Thresholds in ms, measured from the booked start. SOON matches the rider
      // pool's 90-min dispatch grace, so an order is flagged exactly as it leaves the
      // pool rather than while a rider could still legitimately take it.
      const SOON_PAST_MS = 90 * 60 * 1000; // 90 min past start — the dispatch window has closed
      const EXPIRED_MS = 4 * 60 * 60 * 1000; // 4 hours past start — no longer a real same-day slot

      if (pastMs < SOON_PAST_MS) {
        // Too soon to expire; but if it's been confirmed for a while with no rider,
        // that's an ops signal, not an auto-cancel.
        continue;
      }

      if (isPaid) {
        if (pastMs >= EXPIRED_MS) {
          // This order's slot is long gone and it was never dispatched.
          // Move it to a terminal expired state.
          await doc.ref.update({
            status: 'cancelled',
            cancelReason: 'Slot expired — never dispatched',
            expiredAt: nowIso,
            progressPercent: 0,
            updatedAt: nowIso,
          });
          expired++;
          logger.warn('expirePastSlotOrders: expired unpaid/unaccepted paid order', {
            orderId: doc.id,
            startMs,
            pastMs,
          });
          if (order.userId) {
            await pushNotification(order.userId, {
              title: 'Order expired',
              body: `${doc.id} — your delivery slot passed and the order was never dispatched. We’ll be in touch if anything can be done.`,
              type: 'order',
              orderId: doc.id,
            });
          }
          continue;
        }

        // Paid, past slot but not yet deeply expired: flag it so ops can decide
        // (dispatch now for a late slot, refund, or let it expire).
        await doc.ref.update({
          expiredAt: nowIso,
          updatedAt: nowIso,
        });
        flagged++;
      } else {
        // Unpaid / pending with a past slot and no rider: expired.
        await doc.ref.update({
          status: 'cancelled',
          paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'failed',
          cancelReason: 'Slot expired — never dispatched',
          expiredAt: nowIso,
          progressPercent: 0,
          updatedAt: nowIso,
        });
        expired++;
      }
    }

    logger.info('expirePastSlotOrders completed', { checked, expired, flagged, nowMs });
}

export const expirePastSlotOrders = onSchedule(
  { region: REGION, schedule: 'every 10 minutes' },
  async () => {
    await expirePastSlotOrdersInternal();
  }
);

// ——— backfillOrderContacts (one-shot migration) ———

/**
 * One-shot backfill of customer contact (name, phone, door notes) onto open orders
 * that predate it. It runs as a scheduled job so it uses the function's own admin
 * credentials — the local backfill script needs ADC or a service-account key, which
 * isn't configured on this machine.
 *
 * It stands down as soon as `config/contact_backfill.done` is set, so it is safe to
 * leave scheduled; delete it once the migration has run:
 *   firebase functions:delete backfillOrderContacts --region asia-south1
 */
async function backfillOrderContactsInternal() {
    const marker = db.collection('config').doc('contact_backfill');
    if ((await marker.get()).data()?.done === true) {
      logger.info('backfillOrderContacts: already done');
      return;
    }

    const nowIso = new Date().toISOString();
    const snap = await db.collection('orders').limit(500).get();
    let scanned = 0;
    let updated = 0;
    for (const doc of snap.docs) {
      const order = doc.data();
      if (['completed', 'cancelled', 'refunded'].includes(String(order.status))) continue;
      if (order.customerPhone && order.customerName) continue;
      scanned++;

      const contact = await resolveCustomerContact(order.userId, order.addressId, order.addressFull);
      const patch: Record<string, string> = {};
      if (!order.customerName && contact.customerName) patch.customerName = contact.customerName;
      if (!order.customerPhone && contact.customerPhone) patch.customerPhone = contact.customerPhone;
      if (!order.addressInstructions && contact.addressInstructions) {
        patch.addressInstructions = contact.addressInstructions;
      }
      if (!Object.keys(patch).length) continue;

      await doc.ref.update({ ...patch, updatedAt: nowIso });
      updated++;
    }

    await marker.set({ done: true, at: nowIso, scanned, updated }, { merge: true });
    logger.info('backfillOrderContacts done', { scanned, updated });
}

export const backfillOrderContacts = onSchedule(
  { region: REGION, schedule: 'every 5 minutes' },
  async () => {
    await backfillOrderContactsInternal();
  }
);


// ——— extendBooking ———

const EXTENDABLE_STATUSES = ['delivered', 'active'];
const EXTENSION_OPTIONS = [1, 2, 3, 6, 12];

function parseExtraQty(label: string): number {
  const m = label.match(/(\d+)\s*[×x]/);
  return m ? Number(m[1]) || 0 : 0;
}

function parseExtraName(label: string): string {
  const m = label.match(/[×x]\s*(.+?)\s*·/);
  return (m?.[1] ?? '').trim().toLowerCase();
}

/** Per-unit kit price for an extension chunk. Prefers hourly, then exact plan, else pro-rated plan rate. */
/** Extra hours priced from hour packages: exact package, else the next package up pro-rated. */
function planExtensionPrice(plans: { hours?: number; price?: number }[], extraHours: number): number {
  const valid = plans
    .map((x) => ({ hours: Number(x.hours) || 0, price: Number(x.price) || 0 }))
    .filter((x) => x.hours > 0 && x.price > 0)
    .sort((a, b) => a.hours - b.hours);
  if (!valid.length) return 0;
  const exact = valid.find((x) => x.hours === extraHours);
  if (exact) return exact.price;
  const cover = valid.find((x) => x.hours >= extraHours) ?? valid[valid.length - 1];
  return Math.round((cover.price / cover.hours) * extraHours);
}

function extensionKitPrice(product: FnProduct, extraHours: number): number {
  if (product.hourly?.enabled) return priceForHourly(product, extraHours);
  return planExtensionPrice(normalizeFnProduct(product).plans, extraHours);
}

async function computeExtensionQuote(orderId: string, extraHours: number) {
  if (!Number.isInteger(extraHours) || extraHours < 1 || extraHours > 24) {
    throw new HttpsError('invalid-argument', 'additionalHours must be 1–24');
  }
  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;

  if (order.paymentStatus !== 'paid') {
    throw new HttpsError('failed-precondition', 'Order is not paid');
  }
  if (!EXTENDABLE_STATUSES.includes(order.status)) {
    throw new HttpsError('failed-precondition', 'Only live sessions can be extended');
  }
  if (!order.endAt) throw new HttpsError('failed-precondition', 'Order has no end time');

  const oldEndMs = new Date(order.endAt).getTime();
  if (Number.isNaN(oldEndMs)) throw new HttpsError('failed-precondition', 'Invalid order end time');
  const newEndMs = oldEndMs + extraHours * 60 * 60 * 1000;
  // Extension "starts" at the current end — same night/day window rules as a new booking.
  if (!rentalWindowAllowed(oldEndMs, extraHours)) {
    throw new HttpsError(
      'failed-precondition',
      istHourFromMs(oldEndMs) >= NIGHT_START_HOUR_IST
        ? `After 6 PM you can only extend by up to ${NIGHT_MAX_HOURS}h.`
        : 'That extension would end after midnight, when we can’t pick up. Try fewer hours, or enough to reach 6 AM.'
    );
  }
  const newEndIso = new Date(newEndMs).toISOString();

  // Availability: every held unit must be free in [oldEnd, newEnd].
  const reservationIds: string[] = order.reservationIds ?? [];
  const now = Date.now();
  const unitIds: string[] = [];
  let extraControllers = 0;
  for (const rid of reservationIds) {
    const rSnap = await db.collection('inventory_reservations').doc(rid).get();
    const r = rSnap.data();
    if (r?.kind === 'controllers') {
      extraControllers += Math.max(0, Number(r.quantity) || 0);
      continue;
    }
    const unitId = r?.inventoryUnitId as string | undefined;
    if (!unitId) continue;
    unitIds.push(unitId);
    const busy = await unitHasOverlap(unitId, oldEndMs, newEndMs, now, orderId);
    if (busy) {
      throw new HttpsError('resource-exhausted', 'Kit is already booked after your slot — try fewer hours');
    }
  }
  await assertControllersFree(extraControllers, oldEndMs, newEndMs, now, orderId);

  // Price per product group (units × kit rate + addons repriced for extra hours).
  const items: Array<{ productId?: string | null; name: string; price: number }> =
    order.items ?? [];
  const byProduct = new Map<string, number>();
  for (const rid of reservationIds) {
    const rSnap = await db.collection('inventory_reservations').doc(rid).get();
    const pid = rSnap.data()?.productId as string | undefined;
    if (pid) byProduct.set(pid, (byProduct.get(pid) ?? 0) + 1);
  }
  // Fallback for orders without reservations (legacy): one unit per product line.
  if (!byProduct.size) {
    for (const it of items) {
      if (it.productId) byProduct.set(it.productId as string, (byProduct.get(it.productId as string) ?? 0) + 1);
    }
  }

  let extSubtotal = 0;
  const perItem: Array<{ name: string; price: number }> = [];
  /** Itemised lines for the extend screen: kit hours, then each extra (e.g. controllers). */
  const breakdown: Array<{ label: string; amount: number }> = [];
  for (const it of items) {
    const pid = (it.productId as string | undefined) ?? undefined;
    const units = (pid && byProduct.get(pid)) || 1;
    // Split shared product units evenly across its lines.
    const linesForProduct = items.filter((x) => x.productId === it.productId).length || 1;
    const share = units / linesForProduct;
    let lineExt = 0;
    if (pid) {
      const pSnap = await db.collection('products').doc(pid).get();
      if (pSnap.exists) {
        const product = productForStart(pSnap.data() as FnProduct, new Date(order.startAt).getTime());
        // Optional flat extension rates (Admin → product): ₹/extra hour for the kit and per extra controller.
        const ext = (product as FnProduct & { extensionPricing?: { perHour?: number; addonPerHour?: number } })
          .extensionPricing;
        const kitPerHour = Number(ext?.perHour) || 0;
        const addonPerHour = Number(ext?.addonPerHour) || 0;
        const kitExt = (kitPerHour > 0 ? kitPerHour * extraHours : extensionKitPrice(product, extraHours)) * share;
        lineExt += kitExt;
        breakdown.push({
          label: kitPerHour > 0 ? `${it.name} · ${extraHours}h × ₹${kitPerHour}` : `${it.name} · +${extraHours}h`,
          amount: Math.round(kitExt),
        });
        const catalog = normalizeFnProduct(product).addons ?? [];
        for (const extra of (it as { extras?: string[] }).extras ?? []) {
          const qty = parseExtraQty(extra);
          const nm = parseExtraName(extra);
          if (!qty || !nm) continue;
          const addon = catalog.find((a) => a.name.toLowerCase() === nm);
          if (!addon) continue;
          const flat = addonPerHour > 0 && isControllerAddonLike(addon);
          const addonExt = (flat ? addonPerHour * extraHours * qty : priceForAddon(addon, extraHours, qty)) * share;
          lineExt += addonExt;
          breakdown.push({
            label: flat
              ? `${qty}× ${addon.name} · ${extraHours}h × ₹${addonPerHour}`
              : `${qty}× ${addon.name} · +${extraHours}h`,
            amount: Math.round(addonExt),
          });
        }
      } else {
        // Unknown product: pro-rate original line price.
        const origHours = Math.max(1, Math.round((oldEndMs - new Date(order.startAt).getTime()) / 3600000));
        lineExt += Math.round(((it.price ?? 0) / origHours) * extraHours);
      }
    } else {
      // Combo line: price the extra hours from the combo's own hour packages.
      const expId = (it as { experienceId?: string | null }).experienceId ?? undefined;
      const expSnap = expId ? await db.collection('experiences').doc(expId).get() : null;
      const exp = expSnap?.exists ? expSnap.data() : undefined;
      const comboPrice = exp
        ? planExtensionPrice(
            (exp.plans as { hours?: number; price?: number }[] | undefined)?.length
              ? (exp.plans as { hours?: number; price?: number }[])
              : [{ hours: Number(exp.durationHours) || 0, price: Number(exp.price) || 0 }],
            extraHours
          )
        : 0;
      if (comboPrice > 0) {
        lineExt += comboPrice;
        breakdown.push({ label: `${it.name} · +${extraHours}h`, amount: Math.round(comboPrice) });
        const comboAddons = (exp?.addons as FnProduct['addons']) ?? [];
        for (const extra of (it as { extras?: string[] }).extras ?? []) {
          const qty = parseExtraQty(extra);
          const nm = parseExtraName(extra);
          if (!qty || !nm) continue;
          const addon = comboAddons.find((a) => a.name.toLowerCase() === nm);
          if (!addon) continue;
          const addonExt = priceForAddon(addon, extraHours, qty);
          lineExt += addonExt;
          breakdown.push({ label: `${qty}× ${addon.name} · +${extraHours}h`, amount: Math.round(addonExt) });
        }
      } else {
        // Unknown combo: pro-rate the original line price.
        const origHours = Math.max(1, Math.round((oldEndMs - new Date(order.startAt).getTime()) / 3600000));
        lineExt += Math.round(((it.price ?? 0) / origHours) * extraHours);
      }
    }
    lineExt = Math.round(lineExt);
    extSubtotal += lineExt;
    perItem.push({ name: it.name, price: lineExt });
  }

  extSubtotal = Math.round(extSubtotal);
  const taxes = 0;
  const total = extSubtotal + taxes;
  return { order, ref, oldEndMs, newEndMs, newEndIso, extSubtotal, taxes, total, perItem, breakdown, unitIds, reservationIds };
}

export const getExtensionQuote = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId, additionalHours } = request.data as { orderId: string; additionalHours: number };
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required');
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  if (snap.data()?.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');
  const q = await computeExtensionQuote(orderId, additionalHours);
  return {
    ok: true,
    orderId,
    additionalHours,
    available: true,
    newEndAt: q.newEndIso,
    subtotal: q.extSubtotal,
    taxes: q.taxes,
    total: q.total,
    perItem: q.perItem,
    breakdown: q.breakdown,
    options: EXTENSION_OPTIONS,
  };
});

export const createExtensionPaymentOrder = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, additionalHours } = request.data as {
    orderId: string;
    additionalHours: number;
  };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const snap = await db.collection('orders').doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  if (snap.data()?.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');

  const q = await computeExtensionQuote(id, additionalHours);
  const keyId = razorpayKeyId.value();
  const keySecret = razorpayKeySecret.value();
  const nowIso = new Date().toISOString();

  if (!keyId || !keySecret) {
    return {
      demo: true,
      razorpayOrderId: `demo_ext_${randomBytes(6).toString('hex')}`,
      amount: Math.round(q.total * 100),
      currency: 'INR',
      keyId: '',
      newEndAt: q.newEndIso,
      total: q.total,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Razorpay = require('razorpay');
  const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const rzpOrder = await rzp.orders.create({
    amount: Math.round(q.total * 100),
    currency: 'INR',
    receipt: `ext_${id}`.slice(0, 40),
    notes: {
      orderId: id,
      userId: uid,
      kind: 'extension',
      additionalHours: String(additionalHours),
    },
  });

  await db.collection('payments').doc(rzpOrder.id).set({
    id: rzpOrder.id,
    orderId: id,
    userId: uid,
    amount: q.total,
    currency: 'INR',
    provider: 'razorpay',
    providerRef: rzpOrder.id,
    status: 'pending',
    kind: 'extension',
    additionalHours,
    createdAt: nowIso,
  });

  return {
    demo: false,
    razorpayOrderId: rzpOrder.id,
    amount: Math.round(q.total * 100),
    currency: 'INR',
    keyId,
    newEndAt: q.newEndIso,
    total: q.total,
  };
});

export const extendBooking = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id, additionalHours, provider = 'demo', payment } = request.data as {
    orderId: string;
    additionalHours: number;
    provider?: 'demo' | 'razorpay';
    payment?: { razorpayOrderId: string; paymentId: string; signature: string };
  };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  if (snap.data()?.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');

  const q = await computeExtensionQuote(id, additionalHours);
  const nowIso = new Date().toISOString();

  let paymentId: string;
  const gatewayLive = Boolean(razorpayKeySecret.value());
  if (gatewayLive && provider !== 'razorpay') {
    throw new HttpsError('invalid-argument', 'Payment proof required');
  }
  if (provider === 'razorpay') {
    if (!gatewayLive) throw new HttpsError('failed-precondition', 'Payments are not configured');
    if (!payment?.razorpayOrderId || !payment.paymentId || !payment.signature) {
      throw new HttpsError('invalid-argument', 'Payment proof required');
    }
    if (!validRazorpaySignature(payment.razorpayOrderId, payment.paymentId, payment.signature)) {
      throw new HttpsError('permission-denied', 'Payment could not be verified');
    }
    const payRef = db.collection('payments').doc(payment.razorpayOrderId);
    const paySnap = await payRef.get();
    const pay = paySnap.data();
    if (!paySnap.exists || pay?.kind !== 'extension' || pay?.orderId !== id) {
      throw new HttpsError('not-found', 'Extension payment not found');
    }
    if (Number(pay?.additionalHours) !== additionalHours) {
      throw new HttpsError('failed-precondition', 'Payment does not match this extension');
    }
    if (Math.round(Number(pay?.amount) || 0) !== Math.round(q.total)) {
      throw new HttpsError('failed-precondition', 'Extension price changed — refresh and try again');
    }
    paymentId = payment.paymentId;
    // One Razorpay payment extends a session exactly once (the webhook may already
    // have set status=paid, so "applied" is tracked separately).
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(payRef);
      if (fresh.data()?.appliedAt) {
        throw new HttpsError('already-exists', 'This payment has already been used for an extension');
      }
      tx.update(payRef, { status: 'paid', providerRef: paymentId, appliedAt: nowIso, updatedAt: nowIso });
    });
  } else {
    paymentId = `demo_${randomBytes(6).toString('hex')}`;
    await db.collection('payments').doc(paymentId).set({
      id: paymentId,
      orderId: id,
      userId: uid,
      amount: q.total,
      currency: 'INR',
      provider: 'demo',
      providerRef: paymentId,
      status: 'paid',
      kind: 'extension',
      additionalHours,
      createdAt: nowIso,
    });
  }

  await Promise.all(
    q.reservationIds.map((rid) =>
      db.collection('inventory_reservations').doc(rid).update({
        endAt: q.newEndIso,
        updatedAt: nowIso,
      })
    )
  );

  const order = q.order;
  const nextItems = (order.items ?? []).map((it: DocumentData, idx: number) => ({
    ...it,
    price: (it.price ?? 0) + (q.perItem[idx]?.price ?? 0),
    durationLabel: `${it.durationLabel} +${additionalHours}h ext`,
    returnLabel: `Returns ${formatInIndia(new Date(q.newEndMs))}`,
  }));

  const extensionRecord = {
    additionalHours,
    subtotal: q.extSubtotal,
    taxes: q.taxes,
    total: q.total,
    newEndAt: q.newEndIso,
    paymentId,
    createdAt: nowIso,
  };

  await ref.update({
    endAt: q.newEndIso,
    items: nextItems,
    subtotal: (order.subtotal ?? 0) + q.extSubtotal,
    taxes: (order.taxes ?? 0) + q.taxes,
    total: (order.total ?? 0) + q.total,
    extensions: FieldValue.arrayUnion(extensionRecord),
    updatedAt: nowIso,
  });

  await pushNotification(uid, {
    title: 'Session extended',
    body: `${id} extended by ${additionalHours}h — new return ${formatInIndia(new Date(q.newEndMs))}.`,
    type: 'order',
    orderId: id,
  });

  return { ok: true, orderId: id, newEndAt: q.newEndIso, extensionTotal: q.total };
});

// ——— Razorpay ———

export const createRazorpayOrder = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const { orderId: id } = request.data as { orderId: string };
    if (!id) throw new HttpsError('invalid-argument', 'orderId required');

    const snap = await db.collection('orders').doc(id).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
    const order = snap.data()!;
    if (order.userId !== uid) throw new HttpsError('permission-denied', 'Not your order');

    const keyId = razorpayKeyId.value();
    const keySecret = razorpayKeySecret.value();

    if (!keyId || !keySecret) {
      return {
        orderId: id,
        razorpayOrderId: `demo_${id}`,
        amount: Math.round((order.total ?? 0) * 100),
        currency: 'INR',
        keyId: '',
        demo: true,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Razorpay = require('razorpay');
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const amountPaise = Math.round((order.total ?? 0) * 100);
    const rzpOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: id,
      notes: { orderId: id, userId: uid },
    });

    await db.collection('orders').doc(id).update({ razorpayOrderId: rzpOrder.id });
    await db.collection('payments').doc(rzpOrder.id).set({
      id: rzpOrder.id,
      orderId: id,
      userId: uid,
      amount: order.total,
      currency: 'INR',
      provider: 'razorpay',
      providerRef: rzpOrder.id,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    return {
      orderId: id,
      razorpayOrderId: rzpOrder.id,
      amount: amountPaise,
      currency: 'INR',
      keyId,
      demo: false,
    };
  }
);

/**
 * Mark an order paid from webhook / hold-recovery. Works even when the hold
 * sweeper already cancelled the booking — money in the bank must resurrect it.
 */
async function confirmPaidOrderAdmin(orderId: string, providerRef: string) {
  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const order = snap.data()!;
  if (order.paymentStatus === 'paid' && order.status !== 'cancelled' && order.status !== 'refunded') {
    return;
  }

  const nowIso = new Date().toISOString();
  const reservationIds: string[] = order.reservationIds ?? [];
  await Promise.all(
    reservationIds.map(async (rid) => {
      const rRef = db.collection('inventory_reservations').doc(rid);
      const rSnap = await rRef.get();
      if (!rSnap.exists) return;
      await rRef.update({
        status: 'confirmed',
        holdExpiresAt: null,
        updatedAt: nowIso,
      });
    })
  );

  const wasCancelled = order.status === 'cancelled' || order.paymentStatus === 'failed';
  await ref.update({
    paymentStatus: 'paid',
    status: 'confirmed',
    holdExpiresAt: null,
    progressPercent: 20,
    updatedAt: nowIso,
    paymentProvider: 'razorpay',
    paymentMethodLabel: 'Razorpay',
    ...(providerRef.startsWith('pay_') ? { razorpayPaymentId: providerRef } : {}),
    ...(wasCancelled
      ? {
          cancelReason: FieldValue.delete(),
          cancelledAt: FieldValue.delete(),
          recoveredAt: nowIso,
          recoverNote: 'Resurrected after Razorpay capture was confirmed',
        }
      : {}),
  });

  const razorpayOrderId = typeof order.razorpayOrderId === 'string' ? order.razorpayOrderId : null;
  if (razorpayOrderId) {
    await db
      .collection('payments')
      .doc(razorpayOrderId)
      .set(
        {
          status: 'paid',
          providerRef: providerRef || razorpayOrderId,
          updatedAt: nowIso,
        },
        { merge: true }
      );
  }

  if (order.userId) {
    await clearUserCart(order.userId);
    await pushNotification(order.userId, {
      title: 'Payment received',
      body: `${orderId} is confirmed and being packed.`,
      type: 'payment',
      orderId,
    });
  }

  await notifyHubRiders(order.hubId, {
    title: 'New run available',
    body: `${orderId} · ${runSummary(order)} · paid`,
    type: 'delivery',
    orderId,
  });

  await notifyOps({
    kind: 'payment_received',
    severity: wasCancelled ? 'critical' : 'warning',
    title: wasCancelled ? `Recovered paid booking: ${orderId}` : `Paid booking: ${orderId}`,
    body: `${orderId} · ₹${Math.round(Number(order.total) || 0)} · ${runSummary(order)} · starts ${formatInIndia(new Date(order.startAt))}${
      wasCancelled ? ' · was cancelled after hold expiry — check stock' : ''
    }`,
    orderId,
  });
}

export const razorpayWebhook = onRequest(
  { region: REGION },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    // Webhooks are signed with the webhook secret set in the Razorpay dashboard.
    // Unsigned or wrongly signed calls are rejected — they could otherwise mark orders paid.
    const secret = razorpayWebhookSecret.value();
    if (!secret) {
      res.status(503).send('Webhook not configured');
      return;
    }
    const signature = String(req.get('x-razorpay-signature') ?? '');
    const raw: Buffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));
    const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
    const given = Buffer.from(signature);
    if (!signature || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      res.status(400).send('Invalid signature');
      return;
    }

    const event = req.body?.event;
    const paymentEntity = req.body?.payload?.payment?.entity;
    const orderEntity = req.body?.payload?.order?.entity;

    if (event === 'payment.captured' || event === 'order.paid') {
      const razorpayOrderId = paymentEntity?.order_id ?? orderEntity?.id;
      if (razorpayOrderId) {
        const paySnap = await db.collection('payments').doc(razorpayOrderId).get();
        const payData = paySnap.data();
        // Only confirm orders we created a Razorpay order for, and only for the full amount.
        const paidPaise = Number(paymentEntity?.amount ?? orderEntity?.amount_paid ?? 0);
        const expectedPaise = Math.round((Number(payData?.amount) || 0) * 100);
        if (!paySnap.exists || !payData?.orderId) {
          logger.warn('Webhook for unknown Razorpay order', { razorpayOrderId, event });
          // Money was captured that we cannot tie to an order: never let this sit in
          // a log. Ops must reconcile it by hand.
          await notifyOps({
            kind: 'flag',
            severity: 'critical',
            title: 'Payment with no order',
            body: `Razorpay captured ${razorpayOrderId} with no matching order record. Reconcile before fulfilling.`,
            orderId: payData?.orderId as string | undefined,
          });
        } else if (paidPaise !== expectedPaise) {
          logger.error('Webhook amount mismatch — not confirming', { razorpayOrderId, paidPaise, expectedPaise });
          await notifyOps({
            kind: 'flag',
            severity: 'critical',
            title: 'Payment amount mismatch',
            body: `${payData.orderId}: paid ₹${paidPaise / 100} against an expected ₹${expectedPaise / 100}. Not confirmed automatically.`,
            orderId: payData.orderId as string,
          });
        } else {
          await paySnap.ref.update({
            status: 'paid',
            providerRef: paymentEntity?.id ?? razorpayOrderId,
          });
          // Extension payments top up an already-confirmed order — never re-confirm it.
          if (payData.kind !== 'extension') {
            await confirmPaidOrderAdmin(payData.orderId as string, paymentEntity?.id ?? razorpayOrderId);
          }
        }
      }
    }

    if (event === 'payment.failed') {
      const razorpayOrderId = paymentEntity?.order_id;
      if (razorpayOrderId) {
        const paySnap = await db.collection('payments').doc(razorpayOrderId).get();
        const payData = paySnap.data();
        const id = payData?.orderId as string | undefined;
        // A failed attempt can arrive after a later attempt on the same order succeeded
        // (customer retried in the checkout). Never undo a paid order.
        if (payData?.status === 'paid') {
          res.status(200).json({ ok: true, ignored: 'already paid' });
          return;
        }
        if (paySnap.exists) await paySnap.ref.update({ status: 'failed' });
        const orderPaid =
          id && (await db.collection('orders').doc(id).get()).data()?.paymentStatus === 'paid';
        // A failed extension must not cancel the live order.
        if (id && !orderPaid && payData?.kind !== 'extension') {
          const orderRef = db.collection('orders').doc(id);
          const orderSnap = await orderRef.get();
          if (orderSnap.exists) {
            await markOrderPaymentFailedOrCancelled(
              orderRef,
              orderSnap.data()!,
              'Razorpay payment failed'
            );
          }
        }
      }
    }

    res.status(200).json({ ok: true });
  }
);

export const registerFcmToken = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { token } = request.data as { token: string };
  if (!token) throw new HttpsError('invalid-argument', 'token required');
  await db
    .collection('users')
    .doc(uid)
    .set(
      { fcmTokens: FieldValue.arrayUnion(token), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  return { ok: true };
});

export const onReviewCreated = onDocumentCreated(
  { document: 'reviews/{reviewId}', region: REGION },
  async (event) => {
    const data = event.data?.data();
    if (!data?.productId) return;
    const productId = data.productId as string;
    const snap = await db.collection('reviews').where('productId', '==', productId).get();
    let sum = 0;
    snap.forEach((d) => {
      sum += Number(d.data().rating) || 0;
    });
    const count = snap.size;
    const rating = count ? Math.round((sum / count) * 10) / 10 : 0;
    await db.collection('products').doc(productId).set({ rating, reviewCount: count }, { merge: true });
  }
);

/** Availability check for a product/window (read-only helper). */
export const checkAvailability = onCall({ region: REGION }, async (request) => {
  const { productId, hubId: requestedHubId, startAt, endAt, quantity = 1 } = request.data as {
    productId: string;
    hubId?: string;
    startAt: string;
    endAt: string;
    quantity?: number;
  };
  if (!productId || !startAt || !endAt) {
    throw new HttpsError('invalid-argument', 'productId, startAt, endAt required');
  }
  const hubId = await resolveHubId(requestedHubId, request.auth?.uid);
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  const now = Date.now();
  const stockSnap = await db
    .collection('inventory_units')
    .where('productId', '==', productId)
    .where('hubId', '==', hubId)
    .where('status', '==', 'available')
    .get();
  const totalUnits = stockSnap.docs.filter((d) => {
    const from = istDayStartMs(d.data().availableFrom);
    return from == null || startMs >= from;
  }).length;
  try {
    const units = await pickUnitsForProduct(productId, hubId, quantity, startMs, endMs, now);
    return { ok: true, hubId, availableUnitIds: units, totalUnits };
  } catch {
    return { ok: false, hubId, availableUnitIds: [] as string[], totalUnits };
  }
});

/** Rider self-claim — the ONLY path that assigns an order to the caller.
 *  Enforces payment, status, and the 60-min dispatch window on server time,
 *  so no client can claim early or grab assigned/expired runs.
 *  NOTE: named claimRun (not claimDeliveryOrder) — that resource name got
 *  wedged on Google's control plane (eternal update 409s + missing public
 *  invoker) and had to be abandoned. */
export const claimRun = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id } = request.data as { orderId: string };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const riderSnap = await db.collection('riders').doc(uid).get();
  const rider = riderSnap.data();
  if (!riderSnap.exists || rider?.active !== true) {
    throw new HttpsError('permission-denied', 'Not signed in as an active rider');
  }

  const ref = db.collection('orders').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;
  if (order.riderId) throw new HttpsError('failed-precondition', 'Already claimed by another rider');
  if (order.paymentStatus && order.paymentStatus !== 'paid' && order.paymentStatus !== 'cod') {
    throw new HttpsError('failed-precondition', 'Order is not paid yet');
  }
  if (!['confirmed', 'preparing'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'Order is not ready for dispatch');
  }

  // A rider must not be able to grab an order whose original slot has already passed.
  // If the slot is in the future, normal dispatch rules apply.
  // If the slot is now or just passed, only ops (or a late-dispatch flow) should move it.
  // If the slot passed long enough ago that it's no longer a real same-day delivery, refuse.
  const nowMs = Date.now();
  const startMs = order.startAt ? new Date(order.startAt).getTime() : NaN;

  // The rider pool is the *delivery slot*, not the rental window: a 24h rental booked
  // for 11 AM must stop being claimable shortly after 11 AM, not the next morning. So
  // both bounds are measured from startAt.
  const DISPATCH_LEAD_MS = 60 * 60 * 1000;
  const DISPATCH_GRACE_MS = 90 * 60 * 1000;

  if (Number.isFinite(startMs)) {
    if (startMs > nowMs + DISPATCH_LEAD_MS) {
      // Future slot: refuse if it's too far out to dispatch now.
      throw new HttpsError('failed-precondition', 'Too early — this run is not dispatchable yet');
    }

    if (nowMs > startMs + DISPATCH_GRACE_MS) {
      // The delivery slot has closed. A rider must not silently accept a stale order
      // and let onOrderHandedOver quietly slide the clock later.
      const pastMs = nowMs - startMs;
      const STALE_DISPATCH_MS = 3 * 60 * 60 * 1000; // 3h past start = no longer a same-day delivery

      // A late dispatch is an ops decision (customer re-agreement, fee, reschedule,
      // or refund) — a plain rider claim is always refused.
      if (pastMs > STALE_DISPATCH_MS || !request.auth?.token?.admin) {
        throw new HttpsError(
          'failed-precondition',
          'This order’s delivery slot has already passed — ops must review it before anyone can accept it.'
        );
      }
    }
  }

  // Older orders predate the contact fields — fill them as the rider takes the run
  // so they always have a name, number and door instructions to work with.
  const contact =
    order.customerPhone && order.customerName
      ? {}
      : await resolveCustomerContact(order.userId, order.addressId, order.addressFull);

  const nowIso = new Date().toISOString();
  await ref.update({
    riderId: uid,
    riderName: rider.name ?? 'Rider',
    riderPhone: rider.phone ?? '',
    riderAcceptedAt: nowIso,
    status: 'preparing',
    progressPercent: 35,
    liveDispatch: false,
    updatedAt: nowIso,
    etaLabel: 'Being prepared',
    ...(order.customerName || !contact.customerName ? {} : { customerName: contact.customerName }),
    ...(order.customerPhone || !contact.customerPhone ? {} : { customerPhone: contact.customerPhone }),
    ...(order.addressInstructions || !contact.addressInstructions
      ? {}
      : { addressInstructions: contact.addressInstructions }),
  });

  if (order.userId) {
    await pushNotification(order.userId, {
      title: 'Rider assigned',
      body: `${rider.name ?? 'Your rider'} accepted ${id} and is preparing your kit.`,
      type: 'delivery',
      orderId: id,
    }).catch(() => undefined);
  }

  return { ok: true, orderId: id };
});

/**
 * Customer contact for a rider's run. Riders can't read users/{uid}/addresses under
 * the Firestore rules, so orders booked before contact was copied onto the order
 * would leave a rider with no way to reach the customer. This resolves the booked
 * address server-side and returns only what a rider needs — and only for a run the
 * caller can legitimately work (already theirs, or still claimable).
 */
export const getRunContact = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { orderId: id } = request.data as { orderId?: string };
  if (!id) throw new HttpsError('invalid-argument', 'orderId required');

  const riderSnap = await db.collection('riders').doc(uid).get();
  if (!riderSnap.exists || riderSnap.data()?.active !== true) {
    throw new HttpsError('permission-denied', 'Not signed in as an active rider');
  }

  const snap = await db.collection('orders').doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data()!;

  const mine = order.riderId === uid;
  const claimable =
    !order.riderId &&
    ['confirmed', 'preparing'].includes(order.status) &&
    (!order.paymentStatus || order.paymentStatus === 'paid' || order.paymentStatus === 'cod');
  if (!mine && !claimable) {
    throw new HttpsError('permission-denied', 'This run is not available to you');
  }

  // Prefer the fields already on the order; look them up only when missing.
  let contact: CustomerContact = {
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    addressInstructions: order.addressInstructions,
  };
  if (!contact.customerPhone || !contact.customerName) {
    const found = await resolveCustomerContact(order.userId, order.addressId, order.addressFull);
    contact = {
      customerName: contact.customerName ?? found.customerName,
      customerPhone: contact.customerPhone ?? found.customerPhone,
      addressInstructions: contact.addressInstructions ?? found.addressInstructions,
    };
  }

  // Persist what we resolved, so an order booked before contact was copied onto it
  // stops being contactless for the next rider (and for ops in the admin console).
  const patch: Record<string, string> = {};
  if (!order.customerName && contact.customerName) patch.customerName = contact.customerName;
  if (!order.customerPhone && contact.customerPhone) patch.customerPhone = contact.customerPhone;
  if (!order.addressInstructions && contact.addressInstructions) {
    patch.addressInstructions = contact.addressInstructions;
  }
  if (Object.keys(patch).length) {
    await snap.ref
      .update({ ...patch, updatedAt: new Date().toISOString() })
      .catch((err) => logger.warn('getRunContact: could not persist contact', { id, err: String(err) }));
  }

  return {
    customerName: contact.customerName ?? null,
    customerPhone: contact.customerPhone ?? null,
    addressInstructions: contact.addressInstructions ?? null,
  };
});

type PlacesSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
};

type ParsedPlaceAddress = {
  placeId: string;
  formattedAddress: string;
  line1: string;
  line2?: string;
  area: string;
  city: string;
  pincode: string;
  state?: string;
  lat?: number;
  lng?: number;
};

function componentLong(
  components: Array<{ longText?: string; shortText?: string; types?: string[] }> | undefined,
  type: string
): string {
  const hit = components?.find((c) => c.types?.includes(type));
  return hit?.longText || hit?.shortText || '';
}

function parsePlaceDetails(place: Record<string, unknown>): ParsedPlaceAddress {
  const components = (place.addressComponents || []) as Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
  const streetNumber = componentLong(components, 'street_number');
  const route = componentLong(components, 'route');
  const premise = componentLong(components, 'premise');
  const subpremise = componentLong(components, 'subpremise');
  const neighborhood =
    componentLong(components, 'sublocality_level_1') ||
    componentLong(components, 'sublocality') ||
    componentLong(components, 'neighborhood') ||
    componentLong(components, 'sublocality_level_2');
  const city =
    componentLong(components, 'locality') ||
    componentLong(components, 'administrative_area_level_2') ||
    componentLong(components, 'postal_town');
  const pincode = componentLong(components, 'postal_code');
  const state = componentLong(components, 'administrative_area_level_1');

  const lineParts = [subpremise, premise, streetNumber, route].filter(Boolean);
  const line1 = lineParts.join(', ') || (place.formattedAddress as string)?.split(',')[0]?.trim() || '';
  const location = place.location as { latitude?: number; longitude?: number } | undefined;

  return {
    placeId: (place.id as string) || '',
    formattedAddress: (place.formattedAddress as string) || '',
    line1,
    line2: undefined,
    area: neighborhood || city,
    city,
    pincode,
    state: state || undefined,
    lat: location?.latitude,
    lng: location?.longitude,
  };
}

/** Google Places Autocomplete (New) — India-biased, auth required. */
export const placesAutocomplete = onCall({ region: REGION }, async (request) => {
    requireAuth(request.auth?.uid);
    const { input, sessionToken, latitude, longitude, radiusMeters } = (request.data || {}) as {
      input?: string;
      sessionToken?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
    };
    const q = (input || '').trim();
    if (q.length < 2) return { suggestions: [] as PlacesSuggestion[] };

    const key = googleMapsApiKey.value();
    if (!key) throw new HttpsError('failed-precondition', 'Places API key not configured');

    const body: Record<string, unknown> = {
      input: q,
      includedRegionCodes: ['in'],
      languageCode: 'en',
      regionCode: 'IN',
    };
    if (sessionToken) body.sessionToken = sessionToken;
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      body.locationBias = {
        circle: {
          center: { latitude, longitude },
          radius: radiusMeters ?? 45000,
        },
      };
    } else {
      body.locationBias = {
        circle: {
          center: { latitude: SERVICE_CENTER.lat, longitude: SERVICE_CENTER.lng },
          radius: 50000,
        },
      };
    }

    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn('placesAutocomplete failed', { status: res.status, text: text.slice(0, 300) });
      throw new HttpsError('internal', 'Places autocomplete unavailable');
    }
    const data = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          place?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };

    const suggestions: PlacesSuggestion[] = (data.suggestions || [])
      .map((s) => {
        const p = s.placePrediction;
        if (!p?.placeId) return null;
        return {
          placeId: p.placeId,
          primaryText: p.structuredFormat?.mainText?.text || p.text?.text || '',
          secondaryText: p.structuredFormat?.secondaryText?.text || '',
          fullText: p.text?.text || '',
        };
      })
      .filter((s): s is PlacesSuggestion => Boolean(s));

    return { suggestions };
  });

/** Place Details (New) — resolves structured address fields for forms. */
export const placeDetails = onCall({ region: REGION }, async (request) => {
    requireAuth(request.auth?.uid);
    const { placeId, sessionToken } = (request.data || {}) as {
      placeId?: string;
      sessionToken?: string;
    };
    if (!placeId) throw new HttpsError('invalid-argument', 'placeId required');

    const key = googleMapsApiKey.value();
    if (!key) throw new HttpsError('failed-precondition', 'Places API key not configured');

    const params = new URLSearchParams();
    if (sessionToken) params.set('sessionToken', sessionToken);
    const qs = params.toString() ? `?${params}` : '';
    const id = placeId.replace(/^places\//, '');
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}${qs}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'id,formattedAddress,addressComponents,location,displayName',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn('placeDetails failed', { status: res.status, text: text.slice(0, 300) });
      throw new HttpsError('internal', 'Place details unavailable');
    }
    const place = (await res.json()) as Record<string, unknown>;
    return { place: parsePlaceDetails(place) };
  });

/**
 * Pin → address (incl. pincode). Runs server-side because Google refuses
 * reverse geocoding with the app's website-restricted browser key.
 */
/** Typed address → map point, for addresses saved without a pin (so delivery can be priced). */
export const geocodeAddress = onCall({ region: REGION }, async (request) => {
  requireAuth(request.auth?.uid);
  const text = String((request.data as { address?: string } | undefined)?.address ?? '')
    .trim()
    .slice(0, 300);
  if (text.length < 5) throw new HttpsError('invalid-argument', 'address required');
  const key = googleMapsApiKey.value();
  if (!key) throw new HttpsError('failed-precondition', 'Maps API key not configured');

  // Bias to Hyderabad; components keeps results inside India.
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}` +
    `&components=country:IN&region=in&bounds=17.20,78.20|17.60,78.75&key=${key}`;
  const data = (await (await fetch(url)).json()) as {
    status?: string;
    error_message?: string;
    results?: Array<{ geometry?: { location?: { lat: number; lng: number }; location_type?: string }; partial_match?: boolean }>;
  };
  const best = data.results?.[0];
  const point = validLatLng(best?.geometry?.location?.lat, best?.geometry?.location?.lng);
  if (data.status !== 'OK' || !point) {
    logger.warn('geocodeAddress failed', { status: data.status, error: data.error_message });
    return { point: null };
  }
  return {
    point,
    approximate: best?.geometry?.location_type === 'APPROXIMATE' || best?.partial_match === true,
  };
});

export const reverseGeocode = onCall({ region: REGION }, async (request) => {
  requireAuth(request.auth?.uid);
  const { lat, lng } = (request.data || {}) as { lat?: number; lng?: number };
  const point = validLatLng(lat, lng);
  if (!point) throw new HttpsError('invalid-argument', 'lat and lng required');
  const key = googleMapsApiKey.value();
  if (!key) throw new HttpsError('failed-precondition', 'Maps API key not configured');

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${point.lat},${point.lng}&region=in&language=en&key=${key}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    status?: string;
    error_message?: string;
    results?: Array<{
      formatted_address?: string;
      address_components?: Array<{ long_name?: string; types?: string[] }>;
    }>;
  };
  if (data.status !== 'OK' || !data.results?.length) {
    logger.warn('reverseGeocode failed', { status: data.status, error: data.error_message });
    return { address: null };
  }
  const best = data.results[0];
  const comp = (type: string) =>
    data.results
      ?.flatMap((r) => r.address_components ?? [])
      .find((c) => c.types?.includes(type))?.long_name ?? '';
  const own = (type: string) => best.address_components?.find((c) => c.types?.includes(type))?.long_name ?? '';
  const neighborhood = own('sublocality_level_1') || own('sublocality') || own('neighborhood');
  const city = own('locality') || own('administrative_area_level_2') || own('postal_town');
  const lineParts = [own('premise'), own('street_number'), own('route')].filter(Boolean);
  return {
    address: {
      formattedAddress: best.formatted_address ?? '',
      line1: lineParts.join(', ') || best.formatted_address?.split(',')[0]?.trim() || '',
      area: neighborhood || city,
      city,
      // Rooftop results sometimes omit the postcode; the next result over usually has it.
      pincode: (own('postal_code') || comp('postal_code')).replace(/\D/g, '').slice(0, 6),
      state: own('administrative_area_level_1') || undefined,
    },
  };
});
