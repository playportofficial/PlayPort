import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  type DocumentData,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  Address,
  AppNotification,
  CartItem,
  Category,
  Experience,
  HubInfo,
  InventoryUnit,
  Order,
  Product,
  Review,
  User,
} from '@/types';

function mapDocs<T extends { id: string }>(snap: Awaited<ReturnType<typeof getDocs>>): T[] {
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as T);
}

export type OrderingStatus = { paused: boolean; message: string };

/** Live "pause ordering" switch from config/app (Admin → Settings). */
export function watchOrderingStatus(cb: (status: OrderingStatus) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'config', 'app'),
    (snap) => {
      const data = snap.data() as { maintenanceMode?: boolean; maintenanceMessage?: string } | undefined;
      cb({ paused: data?.maintenanceMode === true, message: data?.maintenanceMessage?.trim() ?? '' });
    },
    () => cb({ paused: false, message: '' })
  );
}

export async function fetchCategories(): Promise<Category[]> {
  const snap = await getDocs(collection(db, 'categories'));
  return mapDocs<Category>(snap);
}

export async function fetchProducts(): Promise<Product[]> {
  const snap = await getDocs(collection(db, 'products'));
  return mapDocs<Product>(snap);
}

export async function fetchProduct(id: string): Promise<Product | null> {
  const snap = await getDoc(doc(db, 'products', id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Product;
}

export async function fetchExperiences(): Promise<Experience[]> {
  const snap = await getDocs(collection(db, 'experiences'));
  return mapDocs<Experience>(snap);
}

export async function fetchExperience(id: string): Promise<Experience | null> {
  const snap = await getDoc(doc(db, 'experiences', id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Experience;
}

export async function fetchActiveHubs(): Promise<HubInfo[]> {
  const snap = await getDocs(query(collection(db, 'hubs'), where('active', '==', true)));
  return mapDocs<HubInfo>(snap);
}

export async function fetchHub(id: string): Promise<HubInfo | null> {
  const snap = await getDoc(doc(db, 'hubs', id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as HubInfo;
}

/** Prefer explicit id, else first active hub from Firestore. */
export async function resolveDefaultHub(preferredId?: string | null): Promise<HubInfo | null> {
  if (preferredId) {
    const hub = await fetchHub(preferredId);
    if (hub?.active !== false) return hub;
  }
  const active = await fetchActiveHubs();
  return active[0] ?? null;
}

export async function fetchInventoryUnitsForHub(hubId: string): Promise<InventoryUnit[]> {
  const snap = await getDocs(query(collection(db, 'inventory_units'), where('hubId', '==', hubId)));
  return mapDocs<InventoryUnit>(snap);
}

/** The customer's 4-digit pickup code (private to them; the rider enters it to close the order). */
export function watchPickupCode(orderId: string, cb: (code: string | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'orders', orderId, 'private', 'codes'),
    (snap) => cb(snap.exists() ? String(snap.data()?.pickupOtp ?? '') || null : null),
    () => cb(null)
  );
}

/** Live units for a hub, so maintenance/available flips show without a reload. */
export function watchInventoryUnitsForHub(
  hubId: string,
  cb: (units: InventoryUnit[]) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'inventory_units'), where('hubId', '==', hubId)),
    (snap) => cb(mapDocs<InventoryUnit>(snap)),
    () => {}
  );
}

export async function upsertUserProfile(userId: string, data: Partial<User> & DocumentData) {
  const cleaned: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) cleaned[key] = value;
  }
  await setDoc(
    doc(db, 'users', userId),
    {
      ...cleaned,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

export async function fetchUserProfile(userId: string): Promise<User | null> {
  const snap = await getDoc(doc(db, 'users', userId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as User;
}

export async function fetchUserOrders(userId: string): Promise<Order[]> {
  const snap = await getDocs(
    query(collection(db, 'orders'), where('userId', '==', userId), orderBy('createdAt', 'desc'))
  );
  return mapDocs<Order>(snap);
}

export function watchUserOrders(userId: string, cb: (orders: Order[]) => void): Unsubscribe {
  const q = query(collection(db, 'orders'), where('userId', '==', userId), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    cb(mapDocs<Order>(snap as never));
  });
}

export async function fetchUserCart(userId: string): Promise<CartItem[]> {
  const snap = await getDocs(collection(db, 'users', userId, 'cart'));
  return mapDocs<CartItem>(snap);
}

export async function upsertCartItem(userId: string, item: CartItem) {
  await setDoc(doc(db, 'users', userId, 'cart', item.id), item, { merge: true });
}

export async function deleteCartItem(userId: string, itemId: string) {
  await deleteDoc(doc(db, 'users', userId, 'cart', itemId));
}

export async function clearUserCart(userId: string) {
  const snap = await getDocs(collection(db, 'users', userId, 'cart'));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

export async function replaceUserCart(userId: string, items: CartItem[]) {
  await clearUserCart(userId);
  await Promise.all(items.map((item) => upsertCartItem(userId, item)));
}

export async function fetchUserAddresses(userId: string): Promise<Address[]> {
  const snap = await getDocs(collection(db, 'users', userId, 'addresses'));
  return mapDocs<Address>(snap);
}

export async function upsertAddress(userId: string, address: Address) {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(address)) {
    if (value !== undefined) data[key] = value;
  }
  await setDoc(doc(db, 'users', userId, 'addresses', address.id), data, { merge: true });
}

export async function deleteAddressDoc(userId: string, addressId: string) {
  await deleteDoc(doc(db, 'users', userId, 'addresses', addressId));
}

export async function fetchUserNotifications(userId: string): Promise<AppNotification[]> {
  const snap = await getDocs(
    query(collection(db, 'users', userId, 'notifications'), orderBy('createdAt', 'desc'), limit(50))
  );
  return mapDocs<AppNotification>(snap);
}

export function watchUserNotifications(
  userId: string,
  cb: (items: AppNotification[]) => void
): Unsubscribe {
  const q = query(
    collection(db, 'users', userId, 'notifications'),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs.map((d) => {
        const data = d.data() as AppNotification;
        return {
          ...data,
          id: d.id,
          timeLabel: data.timeLabel ?? relativeTime(data.createdAt),
        };
      })
    );
  });
}

export async function markNotificationReadRemote(userId: string, id: string) {
  await setDoc(doc(db, 'users', userId, 'notifications', id), { read: true }, { merge: true });
}

export async function markAllNotificationsReadRemote(userId: string) {
  const snap = await getDocs(collection(db, 'users', userId, 'notifications'));
  await Promise.all(snap.docs.map((d) => setDoc(d.ref, { read: true }, { merge: true })));
}

function relativeTime(iso?: string) {
  if (!iso) return 'Just now';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function fetchReviews(productId?: string): Promise<Review[]> {
  const q = productId
    ? query(collection(db, 'reviews'), where('productId', '==', productId), orderBy('createdAt', 'desc'))
    : query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(40));
  const snap = await getDocs(q);
  return mapDocs<Review>(snap);
}

export async function createReviewDoc(review: Review & { userId: string; createdAt: string }) {
  await setDoc(doc(db, 'reviews', review.id), review);
}
