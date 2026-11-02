import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  deleteDoc,
  deleteField,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { callClaimDeliveryOrder, callCompleteReturn } from '@/lib/functions';
import { computeDeliveryEta, geocodeAddress } from '@/lib/deliveryEta';
import { createUserNotification } from '@/lib/notify';
import { formatSlot, isDispatchable } from '@/utils/serviceHours';
import type { Order, OrderStatus, Rider } from '@/types';

const PROGRESS: Record<string, number> = {
  preparing: 35,
  out_for_delivery: 55,
  delivered: 70,
  active: 85,
  returning: 92,
  completed: 100,
};

function mapDocs<T extends { id: string }>(snap: Awaited<ReturnType<typeof getDocs>>): T[] {
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as T);
}

function stripUndefined(data: DocumentData): DocumentData {
  const cleaned: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function normalizeRiderPhone(phone?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return `+91${digits.slice(-10)}`;
  return phone || '';
}

export async function checkIsRider(): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return false;
  const snap = await getDoc(doc(db, 'riders', user.uid));
  return snap.exists() && (snap.data() as Rider).active === true;
}

export async function resolveRiderProfile(): Promise<Rider | null> {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, 'riders', user.uid));
  if (!snap.exists()) return null;
  const rider = { id: snap.id, ...snap.data() } as Rider;
  await updateDoc(doc(db, 'riders', user.uid), {
    lastSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    uid: user.uid,
  }).catch(() => undefined);
  return { ...rider, uid: user.uid };
}

export async function riderListRiders(): Promise<Rider[]> {
  const snap = await getDocs(collection(db, 'riders'));
  return mapDocs<Rider>(snap).sort((a, b) => a.name.localeCompare(b.name));
}

export async function riderUpsert(rider: Rider): Promise<void> {
  const now = new Date().toISOString();
  await setDoc(
    doc(db, 'riders', rider.id),
    stripUndefined({
      ...rider,
      phone: normalizeRiderPhone(rider.phone),
      uid: rider.uid || rider.id,
      updatedAt: now,
      createdAt: rider.createdAt || now,
    } as unknown as DocumentData),
    { merge: true }
  );
}

export async function riderSetActive(id: string, active: boolean): Promise<void> {
  await updateDoc(doc(db, 'riders', id), {
    active,
    updatedAt: new Date().toISOString(),
  });
}

export async function riderDelete(id: string): Promise<void> {
  await deleteDoc(doc(db, 'riders', id));
}

export function watchRiderOrders(
  riderId: string,
  cb: (available: Order[], mine: Order[]) => void
): Unsubscribe {
  return onSnapshot(collection(db, 'orders'), (snap) => {
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Order);
    const now = new Date();
    const available = all
      .filter(
        (o) =>
          !o.riderId &&
          (!o.paymentStatus || o.paymentStatus === 'paid' || o.paymentStatus === 'cod') &&
          ['confirmed', 'preparing'].includes(o.status) &&
          // Scheduled runs surface ~1h before startAt, never after endAt.
          isDispatchable(o, now)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const mine = all
      .filter((o) => o.riderId === riderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    cb(available, mine);
  });
}

export async function riderAcceptOrder(orderId: string, rider: Rider): Promise<void> {
  const ref = doc(db, 'orders', orderId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Order not found');
  const order = snap.data() as Order;
  if (order.riderId) throw new Error('Already claimed by another rider');
  if (order.paymentStatus && order.paymentStatus !== 'paid' && order.paymentStatus !== 'cod') {
    throw new Error('Order is not paid yet');
  }
  if (!['confirmed', 'preparing'].includes(order.status)) {
    throw new Error('Order is not ready for dispatch');
  }
  if (!isDispatchable(order)) {
    const when = order.startAt ? formatSlot(order.startAt) : null;
    throw new Error(
      when ? `Too early — this run starts ${when}` : 'This run is no longer dispatchable'
    );
  }
  const now = new Date().toISOString();
  const address = order.addressFull || order.addressLabel || '';
  const dropoff = await geocodeAddress(address);

  await updateDoc(ref, {
    riderId: rider.id,
    riderName: rider.name,
    riderPhone: rider.phone,
    riderAcceptedAt: now,
    status: 'preparing',
    progressPercent: PROGRESS.preparing,
    liveDispatch: false,
    updatedAt: now,
    etaLabel: 'Being prepared',
    ...(dropoff ? { dropoffLat: dropoff.lat, dropoffLng: dropoff.lng } : {}),
  });

  if (order.userId) {
    await createUserNotification(order.userId, {
      title: 'Rider assigned',
      body: `${rider.name} accepted ${orderId} and is preparing your kit.`,
      type: 'delivery',
      orderId,
    }).catch(() => undefined);
  }
}

/**
 * Rider self-claim via the server function (airtight: payment, status, and
 * dispatch window enforced on server time). No silent fallback — a failed
 * claim must surface, never write directly.
 */
export async function riderClaimOwnOrder(orderId: string): Promise<void> {
  // Stale ID tokens 401 at the edge even while Firestore reads keep working
  // off cache — force one fresh token before the claim.
  try {
    if (auth.currentUser) await auth.currentUser.getIdToken(true);
  } catch {
    // Refresh failed (offline/revoked) — the call below will say so clearly.
  }
  let claimed: { ok: boolean } | null = null;
  try {
    claimed = await callClaimDeliveryOrder(orderId);
  } catch (e) {
    throw new Error(friendlyClaimError(e));
  }
  if (!claimed?.ok) throw new Error('Claim failed — try again');

  // Backfill exact coords when the order predates saved pins (own job → allowed).
  try {
    const ref = doc(db, 'orders', orderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const order = snap.data() as Order;
    if (order.dropoffLat != null && order.dropoffLng != null) return;
    const dropoff = await geocodeAddress(order.addressFull || order.addressLabel || '');
    if (dropoff) {
      await updateDoc(ref, {
        dropoffLat: dropoff.lat,
        dropoffLng: dropoff.lng,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Coords are best-effort; the claim itself already succeeded.
  }
}

function friendlyClaimError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const raw = e instanceof Error ? e.message : String(e ?? '');
  console.warn('[claim] failed', code || '(no code)', raw);
  if (code === 'functions/unauthenticated' || /unauthenticated|not signed in/i.test(raw)) {
    return 'Session expired — reopen the app, sign in again, then accept.';
  }
  if (code === 'functions/permission-denied') {
    const detail = raw.replace(/^.*?:\s*/, '').replace(/\s*\(functions\/[^)]*\)\s*$/, '');
    return detail || 'This account is not an active rider.';
  }
  if (code === 'functions/failed-precondition') {
    const detail = raw.replace(/^.*?:\s*/, '').replace(/\s*\(functions\/[^)]*\)\s*$/, '');
    return detail || 'This run can’t be accepted right now.';
  }
  if (code === 'functions/not-found') return 'That order no longer exists.';
  if (code === 'functions/unavailable' || code === 'functions/deadline-exceeded' || code === 'functions/internal') {
    // Temporary: include the code so a screenshot tells us exactly which one.
    return `Server hiccup (${code.replace('functions/', '')}) — try accepting again in a moment.`;
  }
  const cleaned = raw
    .replace(/^FirebaseError:\s*/, '')
    .replace(/\s*\(functions\/[^)]*\)\s*$/, '')
    .trim();
  return cleaned || 'Couldn’t accept — check your connection and retry.';
}

/** Ping rider GPS → distance + ETA on the order (no map shared with customer). */
export async function riderPingLocation(
  orderId: string,
  riderId: string,
  lat: number,
  lng: number
): Promise<{ etaMinutes: number; distanceKm: number }> {
  const ref = doc(db, 'orders', orderId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Order not found');
  const order = snap.data() as Order;
  if (order.riderId !== riderId) throw new Error('Not your delivery');
  if (!['out_for_delivery', 'returning'].includes(order.status)) {
    return { etaMinutes: order.etaMinutes ?? 0, distanceKm: order.riderDistanceKm ?? 0 };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01)) {
    return { etaMinutes: order.etaMinutes ?? 0, distanceKm: order.riderDistanceKm ?? 0 };
  }

  let dropLat = order.dropoffLat;
  let dropLng = order.dropoffLng;
  if (dropLat == null || dropLng == null) {
    const geo = await geocodeAddress(order.addressFull || order.addressLabel || '');
    if (geo) {
      dropLat = geo.lat;
      dropLng = geo.lng;
    }
  }

  const now = new Date().toISOString();
  let etaMinutes = order.etaMinutes ?? 30;
  let distanceKm = order.riderDistanceKm ?? 0;
  const patch: DocumentData = {
    riderLat: lat,
    riderLng: lng,
    riderLocationUpdatedAt: now,
    updatedAt: now,
  };

  if (dropLat != null && dropLng != null) {
    const computed = await computeDeliveryEta(lat, lng, dropLat, dropLng);
    etaMinutes = computed.etaMinutes;
    distanceKm = computed.distanceKm;
    patch.dropoffLat = dropLat;
    patch.dropoffLng = dropLng;
    patch.etaSource = computed.source;
    if (distanceKm < 0.05 || etaMinutes <= 0) {
      patch.etaLabel = 'Arriving now';
      patch.etaMinutes = 1;
      patch.riderDistanceKm = deleteField();
    } else {
      patch.etaMinutes = etaMinutes;
      patch.riderDistanceKm = distanceKm;
      patch.etaLabel =
        computed.source === 'road'
          ? `${etaMinutes} min away · ${distanceKm} km`
          : `${etaMinutes} min away (approx)`;
    }
  }

  await updateDoc(ref, patch);
  return { etaMinutes, distanceKm };
}

export async function riderUpdateOrderStatus(
  orderId: string,
  status: OrderStatus,
  riderId: string,
  otp?: string
): Promise<void> {
  const ref = doc(db, 'orders', orderId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Order not found');
  const order = snap.data() as Order;
  if (order.riderId !== riderId) throw new Error('Not your delivery');

  const allowed: Record<string, OrderStatus[]> = {
    preparing: ['out_for_delivery'],
    out_for_delivery: ['delivered'],
    delivered: ['active', 'returning'],
    active: ['returning'],
    returning: ['completed'],
  };
  const next = allowed[order.status] ?? [];
  if (!next.includes(status)) {
    throw new Error(`Cannot move ${order.status} → ${status}`);
  }

  // Handover verification: new orders carry a 4-digit code the customer reads aloud.
  if (status === 'delivered' && order.deliveryOtp) {
    const digits = (otp ?? '').replace(/\D/g, '');
    if (digits !== String(order.deliveryOtp).replace(/\D/g, '')) {
      throw new Error('Wrong code — ask the customer for the 4-digit handover code');
    }
  }

  if (status === 'completed') {
    // Server checks the customer's pickup code, closes the order and frees the kit.
    await callCompleteReturn(orderId, otp);
    return;
  }

  const now = new Date().toISOString();
  const enRoute = status === 'out_for_delivery' || status === 'returning';
  await updateDoc(ref, {
    status,
    progressPercent: PROGRESS[status] ?? order.progressPercent,
    updatedAt: now,
    liveDispatch: enRoute,
    ...(status === 'out_for_delivery' ? { etaLabel: 'Rider on the way' } : {}),
    ...(status === 'delivered'
      ? { etaLabel: 'Delivered', etaMinutes: deleteField(), riderDistanceKm: deleteField() }
      : {}),
    ...(status === 'active' ? { etaLabel: 'With you' } : {}),
    ...(status === 'returning'
      ? {
          etaLabel: 'On the way for pickup',
          etaMinutes: deleteField(),
          riderDistanceKm: deleteField(),
        }
      : {}),
  });

  if (order.userId) {
    const messages: Partial<Record<OrderStatus, { title: string; body: string }>> = {
      out_for_delivery: {
        title: 'Rider on the way',
        body: `${orderId} is heading to you.`,
      },
      delivered: {
        title: 'Kit delivered',
        body: `${orderId} has been delivered and set up.`,
      },
      returning: {
        title: 'Return pickup started',
        body: `Your rider is on the way to pick up ${orderId}.`,
      },
      completed: {
        title: 'Return complete',
        body: `${orderId} is closed. Thanks for renting with PlayPort.`,
      },
    };
    const msg = messages[status];
    if (msg) {
      await createUserNotification(order.userId, {
        ...msg,
        type: 'delivery',
        orderId,
      }).catch(() => undefined);
    }
  }
}

export async function riderGetOrder(orderId: string): Promise<Order | null> {
  const snap = await getDoc(doc(db, 'orders', orderId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Order;
}

export function watchOrder(orderId: string, cb: (order: Order | null) => void): Unsubscribe {
  return onSnapshot(doc(db, 'orders', orderId), (snap) => {
    if (!snap.exists()) {
      cb(null);
      return;
    }
    cb({ id: snap.id, ...snap.data() } as Order);
  });
}

export async function adminAssignRider(orderId: string, rider: Rider): Promise<void> {
  // Same path as rider self-accept so customer gets ETA + en-route status.
  await riderAcceptOrder(orderId, rider);
}
