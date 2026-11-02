import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import {
  cartItemHours,
  expectedLineTotal,
  normalizeFnProduct,
  priceForAddon,
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
/** Payment hold TTL before inventory is released automatically. */
const HOLD_TTL_MS = 15 * 60 * 1000;

const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['cancelled'],
  confirmed: ['preparing', 'cancelled', 'refunded'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
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

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  return uid;
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

/** Pickups run 8 AM – midnight IST, so a rental must end between 8:00 AM and 11:59 PM. */
function endsInServiceHours(endMs: number): boolean {
  return new Date(endMs + 5.5 * 60 * 60 * 1000).getUTCHours() >= 8;
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

// ——— createBooking ———

export const createBooking = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const {
    hubId: requestedHubId,
    cart,
    addressLabel,
    addressFull,
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
  // Service hours (IST): dropoffs run 8 AM – midnight. Scheduled starts must
  // land inside the window; the session itself may run overnight (e.g. 4 PM – 4 AM).
  if (startAt.getTime() < now - 5 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'That slot already passed — pick a new time');
  }
  if (startAt.getTime() > now + 31 * 24 * 60 * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'Bookings open up to 30 days ahead');
  }
  // Cash on delivery is ASAP-only (start ≈ now + 45 min); scheduled orders pay online.
  if (isCod && startAt.getTime() > now + 90 * 60 * 1000) {
    throw new HttpsError(
      'failed-precondition',
      'Cash on delivery is only for ASAP orders. Pay online to schedule a later slot.'
    );
  }
  const startIstHour = new Date(startAt.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
  if (startIstHour < 8 || startIstHour >= 24) {
    throw new HttpsError(
      'failed-precondition',
      'We’re closed 12–8 AM. Schedule your dropoff from 8 AM onwards.'
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
      for (const pid of (expData?.productIds ?? []) as string[]) {
        const inner = (await db.collection('products').doc(pid).get()).data();
        assertLaunched(startAt.getTime(), inner?.availableFrom, String(inner?.shortName || inner?.name || pid));
      }
      const plans = (expData?.plans ?? []) as { id?: string; hours?: number; price?: number }[];
      const expAddons = (expData?.addons ?? []) as {
        id: string;
        name: string;
        maxQuantity: number;
        pricing: { perHour: number; perHourMaxPlanHours: number; flatPrice: number; flatMinPlanHours: number; tiers?: { upToHours: number; price: number; mode?: 'flat' | 'hourly' }[] };
      }[];
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
  if (!endsInServiceHours(endAt.getTime())) {
    throw new HttpsError(
      'failed-precondition',
      `This ${maxHours}h rental would end after midnight, when we can’t pick up. Pick an earlier start or a longer plan.`
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

  const holdExp = order.holdExpiresAt ? new Date(order.holdExpiresAt).getTime() : 0;
  if (holdExp && holdExp < Date.now() && order.paymentStatus === 'pending') {
    await markOrderPaymentFailedOrCancelled(ref, order, 'Hold expired');
    throw new HttpsError('deadline-exceeded', 'Payment hold expired — start checkout again');
  }

  const nowIso = new Date().toISOString();
  let paymentId: string;
  if (gatewayLive) {
    // With Razorpay configured, only Razorpay's signed proof can mark an order paid.
    if (provider !== 'razorpay' || !payment?.razorpayOrderId || !payment.paymentId || !payment.signature) {
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

  await pushNotification(uid, {
    title: 'Order cancelled',
    body: `${id} was cancelled. Inventory released.`,
    type: 'order',
    orderId: id,
  });

  return { ok: true };
});

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

// ——— onOrderDelivered ———

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
export const onOrderDelivered = onDocumentUpdated(
  { document: 'orders/{orderId}', region: REGION },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || !event.data) return;
    if (after.status !== 'delivered' || before.status === 'delivered' || after.deliveredAt) return;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const bookedStart = new Date(after.startAt).getTime();
    const bookedEnd = new Date(after.endAt).getTime();
    if (!Number.isFinite(bookedStart) || !Number.isFinite(bookedEnd) || bookedEnd <= bookedStart) {
      await event.data.after.ref.update({ deliveredAt: nowIso });
      return;
    }
    const startMs = Math.max(nowMs, bookedStart);
    const endMs = startMs + (bookedEnd - bookedStart);
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    await event.data.after.ref.update({
      deliveredAt: nowIso,
      bookedStartAt: after.bookedStartAt ?? after.startAt,
      bookedEndAt: after.bookedEndAt ?? after.endAt,
      startAt: startIso,
      endAt: endIso,
      updatedAt: nowIso,
    });
    await Promise.all(
      ((after.reservationIds ?? []) as string[]).map((rid) =>
        db
          .collection('inventory_reservations')
          .doc(rid)
          .update({ startAt: startIso, endAt: endIso, updatedAt: nowIso })
          .catch((err) => logger.warn('reservation shift failed', { rid, err: String(err) }))
      )
    );

    if (after.userId) {
      const hours = Math.round((endMs - startMs) / 3600000);
      await pushNotification(after.userId, {
        title: 'Your rental has started',
        body: `${event.params.orderId}: your ${hours}h started at ${timeFmtIst.format(new Date(startMs))} and ends at ${timeFmtIst.format(new Date(endMs))}.`,
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

  for (const oid of orderIds) {
    const orderRef = db.collection('orders').doc(oid);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) continue;
    const order = orderSnap.data()!;
    if (order.paymentStatus !== 'pending') continue;
    await orderRef.update({
      status: 'cancelled',
      paymentStatus: 'failed',
      holdExpiresAt: null,
      progressPercent: 0,
      cancelReason: 'Payment hold expired',
      cancelledAt: nowIso,
      updatedAt: nowIso,
    });
    if (order.userId) {
      await pushNotification(order.userId, {
        title: 'Hold expired',
        body: `${oid} was released after payment timed out.`,
        type: 'order',
        orderId: oid,
      });
    }
  }

  return { releasedReservations: snap.size, ordersTouched: orderIds.size };
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
  if (!endsInServiceHours(newEndMs)) {
    throw new HttpsError(
      'failed-precondition',
      'That extension would end after midnight, when we can’t pick up. Try fewer hours, or enough to reach 8 AM.'
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

async function confirmPaidOrderAdmin(orderId: string, providerRef: string) {
  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const order = snap.data()!;
  if (order.paymentStatus === 'paid') return;

  const nowIso = new Date().toISOString();
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
  });
  if (order.userId) await clearUserCart(order.userId);
  await pushNotification(order.userId, {
    title: 'Payment received',
    body: `${orderId} is confirmed and being packed.`,
    type: 'payment',
    orderId,
  });
  void providerRef;
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
        } else if (paidPaise !== expectedPaise) {
          logger.error('Webhook amount mismatch — not confirming', { razorpayOrderId, paidPaise, expectedPaise });
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
  const totalUnits = stockSnap.size;
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

  // Dispatch window on server time: hide far-future slots, refuse ended ones.
  const nowMs = Date.now();
  if (order.endAt) {
    const endMs = new Date(order.endAt).getTime();
    if (Number.isFinite(endMs) && endMs < nowMs) {
      throw new HttpsError('failed-precondition', 'This run is no longer dispatchable');
    }
  }
  if (order.startAt) {
    const startMs = new Date(order.startAt).getTime();
    if (Number.isFinite(startMs) && startMs > nowMs + 60 * 60 * 1000) {
      throw new HttpsError('failed-precondition', 'Too early — this run is not dispatchable yet');
    }
  }

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
