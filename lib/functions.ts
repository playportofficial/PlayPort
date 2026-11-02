import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { firebaseApp } from '@/lib/firebase';
import type { CartItem, Order, PaymentStatus } from '@/types';

const functions = getFunctions(firebaseApp, 'asia-south1');

if (process.env.EXPO_PUBLIC_USE_EMULATORS === '1') {
  const host =
    process.env.EXPO_PUBLIC_EMULATOR_HOST ??
    (typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1');
  connectFunctionsEmulator(functions, host, 5001);
}

export type CreateBookingInput = {
  hubId?: string;
  cart: CartItem[];
  addressLabel: string;
  addressFull: string;
  /** Exact delivery pin locked on the address (Zepto-style). */
  dropoffLat?: number;
  dropoffLng?: number;
  paymentMethodLabel: string;
  subtotal: number;
  taxes: number;
  total: number;
  startAt?: string;
  /** Confirm immediately and collect cash at handover (skips Razorpay). */
  payOnDelivery?: boolean;
  /** Version of the Terms/Privacy/Refund policies the customer ticked at checkout. */
  termsVersion: string;
};

export type CreateBookingResult = {
  orderId: string;
  order: Order;
  holdExpiresAt: string | null;
};

export type CreateRazorpayOrderResult = {
  orderId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
  demo?: boolean;
};

export type DeliveryQuote = {
  km: number;
  fee: number;
  method: 'road' | 'straight';
  hubId: string;
  freeKm: number;
  ratePerKm: number;
  /** Drop-off out and back + pickup out and back. */
  trips: number;
  /** False when the road distance is past the 15 km service limit. */
  serviceable?: boolean;
};

export async function callQuoteDelivery(input: {
  hubId?: string;
  lat: number;
  lng: number;
}): Promise<DeliveryQuote> {
  const fn = httpsCallable<typeof input, DeliveryQuote>(functions, 'quoteDelivery');
  const res = await fn(input);
  return res.data;
}

export async function callCreateBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const fn = httpsCallable<CreateBookingInput, CreateBookingResult>(functions, 'createBooking');
  const res = await fn(input);
  return res.data;
}

export type RazorpayPaymentProof = { razorpayOrderId: string; paymentId: string; signature: string };

export async function callConfirmPayment(
  orderId: string,
  fail = false,
  provider: 'demo' | 'razorpay' = 'demo',
  payment?: RazorpayPaymentProof
) {
  const fn = httpsCallable<
    { orderId: string; fail?: boolean; provider?: 'demo' | 'razorpay'; payment?: RazorpayPaymentProof },
    { ok: boolean; paymentStatus: PaymentStatus; error?: string }
  >(functions, 'confirmPayment');
  const res = await fn({ orderId, fail, provider, payment });
  return res.data;
}

/** @deprecated use callConfirmPayment */
export async function callConfirmPaymentDemo(orderId: string, fail = false) {
  return callConfirmPayment(orderId, fail);
}

export async function callCancelBooking(orderId: string, reason?: string) {
  const fn = httpsCallable<{ orderId: string; reason?: string }, { ok: boolean }>(
    functions,
    'cancelBooking'
  );
  const res = await fn({ orderId, reason });
  return res.data;
}

export async function callUpdateOrderStatus(orderId: string, status: string) {
  const fn = httpsCallable<{ orderId: string; status: string }, { ok: boolean; status: string }>(
    functions,
    'updateOrderStatus'
  );
  const res = await fn({ orderId, status });
  return res.data;
}

export async function callCompleteReturn(orderId: string, otp?: string) {
  const fn = httpsCallable<{ orderId: string; otp?: string }, { ok: boolean }>(functions, 'completeReturn');
  const res = await fn(otp ? { orderId, otp } : { orderId });
  return res.data;
}

export type ExtensionQuote = {
  ok: boolean;
  orderId: string;
  additionalHours: number;
  available: boolean;
  newEndAt: string;
  subtotal: number;
  taxes: number;
  total: number;
  perItem: { name: string; price: number }[];
  /** Kit hours and each extra (e.g. "1× Extra Controller · 3h × ₹20"). */
  breakdown?: { label: string; amount: number }[];
  options: number[];
};

export async function callGetExtensionQuote(
  orderId: string,
  additionalHours: number
): Promise<ExtensionQuote> {
  const fn = httpsCallable<{ orderId: string; additionalHours: number }, ExtensionQuote>(
    functions,
    'getExtensionQuote'
  );
  const res = await fn({ orderId, additionalHours });
  return res.data;
}

export type ExtensionPaymentProof = {
  razorpayOrderId: string;
  paymentId: string;
  signature: string;
};

export type ExtensionPaymentOrder = {
  demo: boolean;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
  newEndAt: string;
  total: number;
};

export async function callCreateExtensionPaymentOrder(
  orderId: string,
  additionalHours: number
): Promise<ExtensionPaymentOrder> {
  const fn = httpsCallable<
    { orderId: string; additionalHours: number },
    ExtensionPaymentOrder
  >(functions, 'createExtensionPaymentOrder');
  const res = await fn({ orderId, additionalHours });
  return res.data;
}

export async function callExtendBooking(
  orderId: string,
  additionalHours: number,
  provider: 'demo' | 'razorpay' = 'demo',
  payment?: ExtensionPaymentProof
): Promise<{ ok: boolean; orderId: string; newEndAt: string; extensionTotal: number }> {
  const fn = httpsCallable<
    {
      orderId: string;
      additionalHours: number;
      provider?: 'demo' | 'razorpay';
      payment?: ExtensionPaymentProof;
    },
    { ok: boolean; orderId: string; newEndAt: string; extensionTotal: number }
  >(functions, 'extendBooking');
  const res = await fn({ orderId, additionalHours, provider, payment });
  return res.data;
}

export async function callCollectCodPayment(
  orderId: string
): Promise<{ ok: boolean; already?: boolean }> {
  const fn = httpsCallable<{ orderId: string }, { ok: boolean; already?: boolean }>(
    functions,
    'collectCodPayment'
  );
  const res = await fn({ orderId });
  return res.data;
}

export async function callReleaseExpiredHolds() {
  const fn = httpsCallable<Record<string, never>, { releasedReservations: number }>(
    functions,
    'releaseExpiredInventoryHold'
  );
  const res = await fn({});
  return res.data;
}

export async function callCreateRazorpayOrder(orderId: string): Promise<CreateRazorpayOrderResult> {
  const fn = httpsCallable<{ orderId: string }, CreateRazorpayOrderResult>(
    functions,
    'createRazorpayOrder'
  );
  const res = await fn({ orderId });
  return res.data;
}

export async function callRegisterFcmToken(token: string) {
  const fn = httpsCallable<{ token: string }, { ok: boolean }>(functions, 'registerFcmToken');
  const res = await fn({ token });
  return res.data;
}

export async function callCheckAvailability(input: {
  productId: string;
  hubId?: string;
  startAt: string;
  endAt: string;
  quantity?: number;
}) {
  const fn = httpsCallable<typeof input, { ok: boolean; hubId: string; availableUnitIds: string[]; totalUnits: number }>(
    functions,
    'checkAvailability'
  );
  const res = await fn(input);
  return res.data;
}

export async function callClaimDeliveryOrder(
  orderId: string
): Promise<{ ok: boolean; orderId: string }> {
  const fn = httpsCallable<{ orderId: string }, { ok: boolean; orderId: string }>(
    functions,
    'claimRun'
  );
  const res = await fn({ orderId });
  return res.data;
}

export type PlacesSuggestion = {
  placeId: string;
  primaryText: string;
  secondaryText: string;
  fullText: string;
};

export type ResolvedPlaceAddress = {
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

export async function callPlacesAutocomplete(input: {
  input: string;
  sessionToken?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
}) {
  const fn = httpsCallable<
    typeof input,
    { suggestions: PlacesSuggestion[] }
  >(functions, 'placesAutocomplete');
  const res = await fn(input);
  return res.data;
}

export async function callPlaceDetails(input: { placeId: string; sessionToken?: string }) {
  const fn = httpsCallable<typeof input, { place: ResolvedPlaceAddress }>(functions, 'placeDetails');
  const res = await fn(input);
  return res.data;
}

export type ReverseGeocodeResult = {
  formattedAddress: string;
  line1: string;
  area: string;
  city: string;
  pincode: string;
  state?: string;
};

export async function callGeocodeAddress(address: string) {
  const fn = httpsCallable<
    { address: string },
    { point: { lat: number; lng: number } | null; approximate?: boolean }
  >(functions, 'geocodeAddress');
  const res = await fn({ address });
  return res.data;
}

export async function callReverseGeocode(input: { lat: number; lng: number }) {
  const fn = httpsCallable<typeof input, { address: ReverseGeocodeResult | null }>(functions, 'reverseGeocode');
  const res = await fn(input);
  return res.data.address;
}
