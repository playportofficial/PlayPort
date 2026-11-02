import { create } from 'zustand';
import { PAYMENT_METHODS } from '@/constants/paymentMethods';
import {
  confirmPhoneLogin,
  mapFirebaseUserToAppUser,
  signOutUser,
  startPhoneLogin,
  watchAuth,
} from '@/lib/auth';
import {
  clearUserCart,
  createReviewDoc,
  deleteAddressDoc,
  deleteCartItem,
  fetchReviews,
  fetchUserAddresses,
  fetchUserCart,
  fetchUserNotifications,
  fetchUserOrders,
  fetchUserProfile,
  markAllNotificationsReadRemote,
  markNotificationReadRemote,
  replaceUserCart,
  upsertAddress,
  upsertCartItem,
  upsertUserProfile,
  watchUserNotifications,
  watchUserOrders,
} from '@/lib/firestore';
import {
  callCancelBooking,
  callConfirmPayment,
  callCreateBooking,
  callCreateRazorpayOrder,
  callGeocodeAddress,
  callQuoteDelivery,
  type DeliveryQuote,
} from '@/lib/functions';
import { openRazorpayCheckout } from '@/lib/razorpay';
import { useCatalogStore } from '@/store/catalogStore';
import { useFeelStore } from '@/store/feelStore';
import { calcCartTotals } from '@/utils/format';
import { experienceImage } from '@/utils/images';
import { isInServiceArea, OUT_OF_AREA_MESSAGE, OUT_OF_AREA_TITLE } from '@/utils/serviceArea';
import { isAsapAvailable, isServiceOpen, isValidScheduledStart } from '@/utils/serviceHours';
import { formatLaunchDay, orderNotBefore } from '@/utils/launch';
import { productForStart, repriceCartForStart } from '@/utils/priceChange';
import { formatFunctionsError } from '@/utils/functionsError';
import { isPlaceholderName } from '@/utils/onboarding';
import {
  addonsTotal,
  computeAddonLines,
  defaultExperiencePlan,
  defaultPlan,
  experiencePlans,
  kitUnitPrice,
  normalizeProduct,
  priceForAddon,
  resolveHours,
} from '@/utils/rentalPricing';
import type {
  Address,
  AppNotification,
  CartItem,
  PricingMode,
  Order,
  PaymentMethod,
  Review,
  User,
} from '@/types';
import type { Unsubscribe } from 'firebase/firestore';

export type AddToCartOptions = {
  planId?: string;
  pricingMode?: PricingMode;
  hours?: number;
  addons?: { id: string; quantity: number }[];
  quantity?: number;
  inventoryUnitId?: string;
  unitLabel?: string;
};

export type PendingCartAdd =
  | { kind: 'product'; productId: string; options?: AddToCartOptions }
  | { kind: 'experience'; experienceId: string; planId?: string; addons?: { id: string; quantity: number }[] };

interface AppState {
  isAuthenticated: boolean;
  authReady: boolean;
  phoneDraft: string;
  otpMode: 'firebase' | 'mock' | null;
  user: User | null;
  cart: CartItem[];
  addresses: Address[];
  selectedAddressId: string | null;
  paymentMethods: PaymentMethod[];
  selectedPaymentMethodId: string;
  orders: Order[];
  notifications: AppNotification[];
  reviews: Review[];
  recentSearches: string[];
  lastOrderId: string | null;
  paymentError: string | null;
  pendingOrderId: string | null;
  pendingCartAdd: PendingCartAdd | null;
  /** ISO start for a scheduled order; null = ASAP. */
  scheduledStartAt: string | null;
  /** Delivery + pickup charge for the selected address's pin (free ≤ 5 km, then ₹7/km × 4 trips). */
  deliveryQuote: (DeliveryQuote & { key: string }) | null;
  deliveryQuoteStatus: 'idle' | 'loading' | 'ready' | 'needsPin' | 'error';
  deliveryQuoteError: string | null;

  bootstrapAuth: () => () => void;
  setPhoneDraft: (phone: string) => void;
  requestOtp: (phone: string) => Promise<'firebase' | 'mock'>;
  login: (code: string) => Promise<void>;
  logout: () => void;
  hydrateUserData: (userId: string) => Promise<void>;
  updateUserProfile: (patch: Partial<User>) => Promise<void>;

  queueCartAdd: (add: PendingCartAdd) => void;
  addProductToCart: (productId: string, options?: AddToCartOptions) => void;
  addExperienceToCart: (
    experienceId: string,
    planId?: string,
    addons?: { id: string; quantity: number }[]
  ) => void;
  updateCartQuantity: (cartItemId: string, quantity: number) => void;
  updateCartPlan: (
    cartItemId: string,
    patch: {
      planId?: string;
      pricingMode?: PricingMode;
      hours?: number;
      addons?: { id: string; quantity: number }[];
    }
  ) => void;
  /** @deprecated Use updateCartPlan */
  updateCartDuration: (cartItemId: string, planId: string) => void;
  removeFromCart: (cartItemId: string) => void;
  clearCart: () => void;
  syncCartRemote: () => void;

  selectAddress: (id: string) => void;
  setScheduledStartAt: (iso: string | null) => void;
  /** Re-price cart lines for the chosen start (scheduled price changes). */
  refreshCartPrices: () => void;
  refreshDeliveryQuote: () => Promise<DeliveryQuote | null>;
  addAddress: (address: Omit<Address, 'id'>) => Promise<string>;
  updateAddress: (id: string, patch: Partial<Address>) => void;
  deleteAddress: (id: string) => void;
  setDefaultAddress: (id: string) => void;

  selectPaymentMethod: (id: string) => void;
  placeOrder: (
    fail?: boolean,
    opts?: { termsVersion?: string }
  ) => Promise<{ ok: boolean; orderId?: string; error?: string }>;
  cancelOrder: (orderId: string, reason: string) => Promise<void>;
  applyOrderExtension: (orderId: string, patch: Partial<Order>) => void;

  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  addReview: (review: Omit<Review, 'id' | 'dateLabel' | 'userName'>) => void;
  loadReviews: () => Promise<void>;
  pushRecentSearch: (query: string) => void;
  clearRecentSearches: () => void;
  clearPaymentError: () => void;
}

let ordersUnsub: Unsubscribe | null = null;
let notifUnsub: Unsubscribe | null = null;

function clearListeners() {
  ordersUnsub?.();
  notifUnsub?.();
  ordersUnsub = null;
  notifUnsub = null;
}

/** IDs previously auto-seeded from mock data — strip so profiles stay empty until real onboarding. */
const LEGACY_MOCK_ADDRESS_IDS = new Set(['addr-home', 'addr-office', 'addr-villa']);

function attachListeners(userId: string, set: (partial: Partial<AppState>) => void) {
  clearListeners();
  ordersUnsub = watchUserOrders(userId, (orders) => set({ orders }));
  notifUnsub = watchUserNotifications(userId, (notifications) => set({ notifications }));
}

export const useAppStore = create<AppState>((set, get) => ({
  isAuthenticated: false,
  authReady: false,
  phoneDraft: '',
  otpMode: null,
  user: null,
  cart: [],
  addresses: [],
  selectedAddressId: null,
  paymentMethods: PAYMENT_METHODS,
  selectedPaymentMethodId: PAYMENT_METHODS[0].id,
  orders: [],
  notifications: [],
  reviews: [],
  recentSearches: [],
  lastOrderId: null,
  paymentError: null,
  pendingOrderId: null,
  pendingCartAdd: null,
  scheduledStartAt: null,
  deliveryQuote: null,
  deliveryQuoteStatus: 'idle',
  deliveryQuoteError: null,

  bootstrapAuth: () => {
    const unsub = watchAuth(async (firebaseUser) => {
      if (!firebaseUser) {
        clearListeners();
        set({
          authReady: true,
          isAuthenticated: false,
          user: null,
          orders: [],
          notifications: [],
        });
        return;
      }
      try {
        const user = await mapFirebaseUserToAppUser(firebaseUser);
        const phoneDigits = user.phone.replace(/\D/g, '');
        // Anonymous without phone = guest browse; anonymous/phone mock or Phone Auth = signed in
        const signedIn = !firebaseUser.isAnonymous || phoneDigits.length >= 10;
        if (!signedIn) {
          clearListeners();
          set({
            authReady: true,
            isAuthenticated: false,
            user: null,
          });
          return;
        }
        set({ isAuthenticated: true, user, authReady: true });
        await get().hydrateUserData(user.id);
        attachListeners(user.id, set);
      } catch (err) {
        // Don't wipe a valid Firebase session if profile hydrate flaked — keep signed in.
        console.warn('Auth bootstrap profile sync failed:', err);
        const phone = firebaseUser.phoneNumber ?? '';
        const signedIn = !firebaseUser.isAnonymous || phone.replace(/\D/g, '').length >= 10;
        if (!signedIn) {
          set({ authReady: true });
          return;
        }
        const existing = get().user;
        set({
          authReady: true,
          isAuthenticated: true,
          user:
            existing?.id === firebaseUser.uid
              ? existing
              : {
                  id: firebaseUser.uid,
                  name: firebaseUser.displayName || 'PlayPort Member',
                  phone,
                  email: firebaseUser.email ?? '',
                  avatar:
                    firebaseUser.photoURL ||
                    `https://api.dicebear.com/7.x/avataaars/png?seed=${firebaseUser.uid}`,
                  kycVerified: false,
                  sessionsCount: 0,
                  homeHub: 'PlayPort',
                  onboardingComplete: false,
                },
        });
      }
    });
    return () => {
      unsub();
      clearListeners();
    };
  },

  hydrateUserData: async (userId) => {
    try {
      const [cartR, addressesR, ordersR, notificationsR, reviewsR] = await Promise.allSettled([
        fetchUserCart(userId),
        fetchUserAddresses(userId),
        fetchUserOrders(userId),
        fetchUserNotifications(userId),
        fetchReviews(),
      ]);

      const cart = cartR.status === 'fulfilled' ? cartR.value : get().cart;
      const orders = ordersR.status === 'fulfilled' ? ordersR.value : get().orders;
      const notifications =
        notificationsR.status === 'fulfilled' ? notificationsR.value : get().notifications;
      const reviews = reviewsR.status === 'fulfilled' ? reviewsR.value : get().reviews;
      const addresses =
        addressesR.status === 'fulfilled' ? addressesR.value : get().addresses;
      if (addressesR.status === 'rejected') {
        console.warn('addresses failed to load', addressesR.reason);
      }

      const legacy = addresses.filter((a) => LEGACY_MOCK_ADDRESS_IDS.has(a.id));
      const realAddresses = addresses.filter((a) => !LEGACY_MOCK_ADDRESS_IDS.has(a.id));
      if (addressesR.status === 'fulfilled' && legacy.length) {
        void Promise.all(legacy.map((a) => deleteAddressDoc(userId, a.id))).catch(() => {});
      }

      const hub = useCatalogStore.getState().hub;
      const user = get().user;
      if (user && hub?.id && !user.homeHubId) {
        const patched = {
          ...user,
          homeHubId: hub.id,
          homeHub: hub.city || hub.name,
        };
        set({ user: patched });
        void upsertUserProfile(userId, {
          homeHubId: hub.id,
          homeHub: patched.homeHub,
        });
      }

      set({
        cart,
        addresses: realAddresses,
        selectedAddressId:
          realAddresses.find((a) => a.isDefault)?.id ?? realAddresses[0]?.id ?? null,
        orders,
        notifications,
        reviews,
      });

      // Heal profiles that finished setup before onboardingComplete was reliable.
      const healed = get().user;
      if (
        healed &&
        !healed.onboardingComplete &&
        !isPlaceholderName(healed.name) &&
        realAddresses.length > 0
      ) {
        const next = { ...healed, onboardingComplete: true };
        set({ user: next });
        void upsertUserProfile(userId, { onboardingComplete: true }).catch(() => {});
      }
    } catch (e) {
      console.warn('hydrateUserData failed', e);
    }
  },

  updateUserProfile: async (patch) => {
    const user = get().user;
    if (!user?.id) return;
    const next = { ...user, ...patch };
    set({ user: next });
    await upsertUserProfile(user.id, patch);
  },

  setPhoneDraft: (phone) => set({ phoneDraft: phone }),

  requestOtp: async (phone) => {
    const digits = phone.replace(/\D/g, '').slice(-10);
    set({ phoneDraft: digits });
    const { mode } = await startPhoneLogin(digits);
    set({ otpMode: mode });
    return mode;
  },

  login: async (code) => {
    const user = await confirmPhoneLogin(code);
    set({
      isAuthenticated: true,
      user,
      phoneDraft: user.phone.replace(/\D/g, '').slice(-10),
    });
    await get().hydrateUserData(user.id);
    // Re-read profile after hydrate heal so OTP routing sees sticky onboardingComplete.
    const fresh = await fetchUserProfile(user.id);
    if (fresh) {
      set({
        user: {
          ...get().user!,
          ...fresh,
          id: user.id,
          onboardingComplete: Boolean(fresh.onboardingComplete || get().user?.onboardingComplete),
        },
      });
    }
    attachListeners(user.id, set);

    const pending = get().pendingCartAdd;
    if (pending?.kind === 'product') {
      get().addProductToCart(pending.productId, pending.options);
    } else if (pending?.kind === 'experience') {
      get().addExperienceToCart(pending.experienceId, pending.planId, pending.addons);
    }
    if (pending) {
      set({ pendingCartAdd: null });
      useFeelStore.getState().showToast('Added to cart');
    }

    // Push any local cart built while guest, including the item queued before OTP.
    const { cart } = get();
    if (cart.length) {
      await replaceUserCart(user.id, cart);
    }
  },

  logout: () => {
    clearListeners();
    void signOutUser().catch(() => {});
    set({
      isAuthenticated: false,
      user: null,
      cart: [],
      orders: [],
      notifications: [],
      addresses: [],
      selectedAddressId: null,
      pendingOrderId: null,
      pendingCartAdd: null,
      deliveryQuote: null,
      deliveryQuoteStatus: 'idle',
      deliveryQuoteError: null,
    });
  },

  syncCartRemote: () => {
    const { user, cart, isAuthenticated } = get();
    if (!isAuthenticated || !user?.id) return;
    void replaceUserCart(user.id, cart).catch(() => {});
  },

  queueCartAdd: (add) => set({ pendingCartAdd: add }),

  addProductToCart: (productId, options = {}) => {
    const raw = useCatalogStore.getState().products.find((p) => p.id === productId);
    if (!raw) return;
    const product = normalizeProduct(productForStart(raw, get().scheduledStartAt));
    const quantity = options.quantity ?? 1;
    const pricingMode: PricingMode = options.pricingMode ?? 'package';
    const plan =
      pricingMode === 'hourly'
        ? null
        : product.plans.find((p) => p.id === options.planId) ?? defaultPlan(product);
    const planId = pricingMode === 'hourly' ? 'hourly' : plan?.id ?? '12h';
    const hours = resolveHours(product, pricingMode, planId, options.hours);
    const unitPrice = kitUnitPrice(product, pricingMode, planId, hours);
    const addonLines = computeAddonLines(product, hours, options.addons ?? []);
    const extras = addonsTotal(addonLines);
    const durationLabel =
      pricingMode === 'hourly'
        ? `${hours}h hourly`
        : plan?.label ?? planId;
    const key = `${productId}-${pricingMode}-${planId}-${hours}-${options.inventoryUnitId ?? ''}-${addonLines.map((a) => `${a.id}:${a.quantity}`).join(',')}`;
    const existing = get().cart.find(
      (c) =>
        c.productId === productId &&
        c.pricingMode === pricingMode &&
        c.planId === planId &&
        c.hours === hours &&
        (c.inventoryUnitId ?? '') === (options.inventoryUnitId ?? '') &&
        JSON.stringify(c.addons ?? []) === JSON.stringify(addonLines)
    );
    let next: CartItem[];
    if (existing) {
      next = get().cart.map((c) =>
        c.id === existing.id ? { ...c, quantity: c.quantity + quantity } : c
      );
    } else {
      const item: CartItem = {
        id: `cart-${key}-${Date.now()}`,
        productId,
        name: product.shortName,
        image: product.images[0],
        categoryLabel: product.categoryId.replace('-', ' ').toUpperCase(),
        planId,
        durationId: planId,
        durationLabel,
        hours,
        pricingMode,
        unitPrice,
        addons: addonLines,
        addonsTotal: extras,
        inventoryUnitId: options.inventoryUnitId,
        unitLabel: options.unitLabel,
        quantity,
        includesNote: options.unitLabel
          ? `${options.unitLabel}${product.includes[0]?.detail ? ` · ${product.includes[0].detail}` : ''}`
          : product.includes[0]?.detail,
      };
      next = [...get().cart, item];
    }
    set({ cart: next });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) {
      const item = next.find(
        (c) =>
          c.productId === productId &&
          c.planId === planId &&
          c.hours === hours &&
          c.pricingMode === pricingMode
      );
      if (item) void upsertCartItem(uid, item).catch(() => {});
    }
  },

  addExperienceToCart: (experienceId, planId, addonSelections = []) => {
    const exp = useCatalogStore.getState().experiences.find((e) => e.id === experienceId);
    if (!exp) return;
    const plan =
      experiencePlans(exp).find((p) => p.id === planId) ?? defaultExperiencePlan(exp);
    const catalog = exp.addons ?? [];
    const addonLines = addonSelections
      .filter((s) => s.quantity > 0)
      .map((s) => {
        const addon = catalog.find((a) => a.id === s.id);
        if (!addon) return null;
        const qty = Math.min(s.quantity, addon.maxQuantity);
        const total = priceForAddon(addon, plan.hours, qty);
        return {
          id: addon.id,
          name: addon.name,
          quantity: qty,
          unitPrice: qty > 0 ? Math.round(total / qty) : 0,
        };
      })
      .filter(Boolean) as CartItem['addons'];
    const extras = addonsTotal(addonLines);
    const existing = get().cart.find(
      (c) =>
        c.experienceId === experienceId &&
        c.planId === plan.id &&
        JSON.stringify(c.addons ?? []) === JSON.stringify(addonLines)
    );
    let next: CartItem[];
    if (existing) {
      next = get().cart.map((c) =>
        c.id === existing.id ? { ...c, quantity: c.quantity + 1 } : c
      );
    } else {
      const item: CartItem = {
        id: `cart-exp-${experienceId}-${plan.id}-${Date.now()}`,
        experienceId,
        name: exp.name,
        image: experienceImage(exp, useCatalogStore.getState().products) ?? '',
        categoryLabel: exp.tag,
        planId: plan.id,
        durationId: plan.id,
        durationLabel: plan.label,
        hours: plan.hours,
        pricingMode: 'package',
        unitPrice: plan.price,
        addons: addonLines,
        addonsTotal: extras,
        quantity: 1,
        includesNote: exp.includes.slice(0, 2).join(' • '),
      };
      next = [...get().cart, item];
    }
    set({ cart: next });
    get().syncCartRemote();
  },

  updateCartQuantity: (cartItemId, quantity) => {
    const uid = get().user?.id;
    if (quantity <= 0) {
      set({ cart: get().cart.filter((c) => c.id !== cartItemId) });
      if (uid && get().isAuthenticated) void deleteCartItem(uid, cartItemId).catch(() => {});
      return;
    }
    const next = get().cart.map((c) => (c.id === cartItemId ? { ...c, quantity } : c));
    set({ cart: next });
    const item = next.find((c) => c.id === cartItemId);
    if (uid && get().isAuthenticated && item) void upsertCartItem(uid, item).catch(() => {});
  },

  updateCartPlan: (cartItemId, patch) => {
    const products = useCatalogStore.getState().products;
    const experiences = useCatalogStore.getState().experiences;
    set({
      cart: get().cart.map((c) => {
        if (c.id !== cartItemId) return c;
        if (c.experienceId && !c.productId) {
          const exp = experiences.find((e) => e.id === c.experienceId);
          if (!exp) return c;
          const plans = experiencePlans(exp);
          const plan =
            plans.find((p) => p.id === patch.planId) ??
            plans.find((p) => p.id === c.planId) ??
            defaultExperiencePlan(exp);
          const catalog = exp.addons ?? [];
          const selected =
            patch.addons ??
            (c.addons ?? []).map((a) => ({ id: a.id, quantity: a.quantity }));
          const addonLines = selected
            .filter((s) => s.quantity > 0)
            .map((s) => {
              const addon = catalog.find((a) => a.id === s.id);
              if (!addon) return null;
              const qty = Math.min(s.quantity, addon.maxQuantity);
              const total = priceForAddon(addon, plan.hours, qty);
              return {
                id: addon.id,
                name: addon.name,
                quantity: qty,
                unitPrice: qty > 0 ? Math.round(total / qty) : 0,
              };
            })
            .filter(Boolean) as CartItem['addons'];
          return {
            ...c,
            planId: plan.id,
            durationId: plan.id,
            pricingMode: 'package' as const,
            hours: plan.hours,
            durationLabel: plan.label,
            unitPrice: plan.price,
            addons: addonLines,
            addonsTotal: addonsTotal(addonLines),
          };
        }
        if (!c.productId) return c;
        const raw = products.find((p) => p.id === c.productId);
        if (!raw) return c;
        const product = normalizeProduct(productForStart(raw, get().scheduledStartAt));
        const pricingMode = patch.pricingMode ?? c.pricingMode ?? 'package';
        const planId =
          pricingMode === 'hourly'
            ? 'hourly'
            : patch.planId ?? c.planId ?? defaultPlan(product)?.id ?? '12h';
        const hours = resolveHours(product, pricingMode, planId, patch.hours ?? c.hours);
        const unitPrice = kitUnitPrice(product, pricingMode, planId, hours);
        const selected =
          patch.addons ??
          (c.addons ?? []).map((a) => ({ id: a.id, quantity: a.quantity }));
        const addonLines = computeAddonLines(product, hours, selected);
        const extras = addonsTotal(addonLines);
        const plan = product.plans.find((p) => p.id === planId);
        return {
          ...c,
          planId,
          durationId: planId,
          pricingMode,
          hours,
          durationLabel:
            pricingMode === 'hourly' ? `${hours}h hourly` : plan?.label ?? planId,
          unitPrice,
          addons: addonLines,
          addonsTotal: extras,
        };
      }),
    });
    get().syncCartRemote();
  },

  updateCartDuration: (cartItemId, planId) => {
    get().updateCartPlan(cartItemId, { planId, pricingMode: 'package' });
  },

  removeFromCart: (cartItemId) => {
    set({ cart: get().cart.filter((c) => c.id !== cartItemId) });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) void deleteCartItem(uid, cartItemId).catch(() => {});
  },

  clearCart: () => {
    set({ cart: [] });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) void clearUserCart(uid).catch(() => {});
  },

  selectAddress: (id) => set({ selectedAddressId: id }),

  setScheduledStartAt: (iso) => {
    set({ scheduledStartAt: iso });
    get().refreshCartPrices();
  },

  refreshCartPrices: () => {
    const { cart, scheduledStartAt } = get();
    const next = repriceCartForStart(cart, useCatalogStore.getState().products, scheduledStartAt);
    if (next === cart) return;
    set({ cart: next });
    get().syncCartRemote();
  },

  refreshDeliveryQuote: async () => {
    const { addresses, selectedAddressId, user, deliveryQuote } = get();
    const address = addresses.find((a) => a.id === selectedAddressId) ?? addresses[0];
    const key = deliveryQuoteKey(address);
    if (address && !key && get().isAuthenticated) {
      // No map pin: place one from the typed address so delivery can be priced.
      set({ deliveryQuote: null, deliveryQuoteStatus: 'loading', deliveryQuoteError: null });
      const text = [address.line1, address.line2, address.area, address.city || 'Hyderabad', address.pincode]
        .filter(Boolean)
        .join(', ');
      const found = await callGeocodeAddress(text).catch(() => null);
      const current = get().addresses.find((a) => a.id === address.id);
      if (found?.point && current && !deliveryQuoteKey(current)) {
        get().updateAddress(address.id, { lat: found.point.lat, lng: found.point.lng });
        return get().refreshDeliveryQuote();
      }
    }
    if (!address || !key) {
      set({ deliveryQuote: null, deliveryQuoteStatus: address ? 'needsPin' : 'idle', deliveryQuoteError: null });
      return null;
    }
    if (!isInServiceArea(address)) {
      set({ deliveryQuote: null, deliveryQuoteStatus: 'idle', deliveryQuoteError: null });
      return null;
    }
    if (deliveryQuote?.key === key) return deliveryQuote;
    set({ deliveryQuoteStatus: 'loading', deliveryQuoteError: null });
    try {
      const hubId = user?.homeHubId || useCatalogStore.getState().hub?.id;
      const quote = await callQuoteDelivery({
        hubId,
        lat: address.lat as number,
        lng: address.lng as number,
      });
      // The selected address may have changed while this was in flight.
      if (deliveryQuoteKey(get().addresses.find((a) => a.id === get().selectedAddressId) ?? get().addresses[0]) !== key) {
        return null;
      }
      const lat = address.lat as number;
      const lng = address.lng as number;
      const known = address.roadCheck;
      if (!known || known.lat !== lat || known.lng !== lng || known.km !== quote.km) {
        get().updateAddress(address.id, { roadCheck: { lat, lng, km: quote.km } });
      }
      if (quote.serviceable === false) {
        set({ deliveryQuote: null, deliveryQuoteStatus: 'idle', deliveryQuoteError: null });
        return null;
      }
      set({ deliveryQuote: { ...quote, key }, deliveryQuoteStatus: 'ready' });
      return quote;
    } catch (err) {
      set({
        deliveryQuote: null,
        deliveryQuoteStatus: 'error',
        deliveryQuoteError: formatFunctionsError(err),
      });
      return null;
    }
  },

  addAddress: async (address) => {
    const id = `addr-${Date.now()}`;
    const next = address.isDefault
      ? get().addresses.map((a) => ({ ...a, isDefault: false }))
      : get().addresses;
    const created = { ...address, id };
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) {
      if (address.isDefault) {
        await Promise.all(next.map((a) => upsertAddress(uid, { ...a, isDefault: false })));
      }
      await upsertAddress(uid, created);
    }
    set({
      addresses: [...next, created],
      selectedAddressId: address.isDefault ? id : get().selectedAddressId ?? id,
    });
    return id;
  },

  updateAddress: (id, patch) => {
    const next = get().addresses.map((a) => {
      if (a.id !== id) {
        return patch.isDefault ? { ...a, isDefault: false } : a;
      }
      return { ...a, ...patch };
    });
    set({ addresses: next });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) {
      void Promise.all(next.map((a) => upsertAddress(uid, a))).catch(() => {});
    }
  },

  deleteAddress: (id) => {
    const remaining = get().addresses.filter((a) => a.id !== id);
    const selected = get().selectedAddressId === id ? remaining[0]?.id ?? null : get().selectedAddressId;
    set({ addresses: remaining, selectedAddressId: selected });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) void deleteAddressDoc(uid, id).catch(() => {});
  },

  setDefaultAddress: (id) => {
    const next = get().addresses.map((a) => ({ ...a, isDefault: a.id === id }));
    set({ addresses: next, selectedAddressId: id });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) {
      void Promise.all(next.map((a) => upsertAddress(uid, a))).catch(() => {});
    }
  },

  selectPaymentMethod: (id) => set({ selectedPaymentMethodId: id, paymentError: null }),

  placeOrder: async (fail = false, opts) => {
    const { cart, addresses, selectedAddressId, selectedPaymentMethodId, paymentMethods, user, pendingOrderId, scheduledStartAt } =
      get();
    if (!user?.id) return { ok: false, error: 'Sign in required' };
    if (useCatalogStore.getState().orderingPaused) {
      return { ok: false, error: 'We’re not taking new orders right now. Please check back soon.' };
    }

    // Scheduled start wins when valid; otherwise ASAP. Closed nights force scheduling.
    // Pickups run 8 AM – midnight too, so the whole window must end in service hours.
    const now = new Date();
    const hours = Math.max(1, ...cart.map((c) => c.hours ?? 3));
    const catalog = useCatalogStore.getState();
    const notBefore = orderNotBefore(cart, catalog.products, catalog.experiences, now);
    const scheduledOk = isValidScheduledStart(scheduledStartAt, now, hours, notBefore);
    if (notBefore && !scheduledOk) {
      return {
        ok: false,
        error: `Your cart has a pre-book item — pick a time from ${formatLaunchDay(notBefore)} onwards.`,
      };
    }
    if (scheduledStartAt && !scheduledOk) {
      return {
        ok: false,
        error: isValidScheduledStart(scheduledStartAt, now)
          ? `That start would end your ${hours}h rental after midnight — pick an earlier time or a longer plan.`
          : 'That slot passed — pick a new time.',
      };
    }
    if (!isServiceOpen(now) && !scheduledOk) {
      return { ok: false, error: 'We’re closed 12–8 AM. Schedule for 8 AM onwards.' };
    }
    if (!scheduledOk && !isAsapAvailable(now, hours)) {
      return {
        ok: false,
        error: `Too late for a ${hours}h rental now — it would end after midnight. Schedule it or pick a longer plan.`,
      };
    }
    const startAt = scheduledOk
      ? new Date(scheduledStartAt as string).toISOString()
      : new Date(now.getTime() + 45 * 60 * 1000).toISOString();
    if (!pendingOrderId && repriceCartForStart(cart, catalog.products, startAt, now) !== cart) {
      get().refreshCartPrices();
      return { ok: false, error: 'Prices changed for your chosen time — check the new total and pay again.' };
    }

    const address = addresses.find((a) => a.id === selectedAddressId) ?? addresses[0];
    if (!address?.line1 && !address?.area) {
      return { ok: false, error: 'Add a delivery address before paying' };
    }
    if (!isInServiceArea(address)) {
      return { ok: false, error: `${OUT_OF_AREA_TITLE} ${OUT_OF_AREA_MESSAGE}` };
    }

    if (!deliveryQuoteKey(address)) {
      return { ok: false, error: 'Pin this address on the map so we can work out the delivery charge.' };
    }
    const quote = pendingOrderId ? null : await get().refreshDeliveryQuote();
    if (!pendingOrderId && !quote) {
      return { ok: false, error: get().deliveryQuoteError ?? 'Couldn’t work out the delivery charge — try again.' };
    }

    const payment = paymentMethods.find((p) => p.id === selectedPaymentMethodId);
    const isCod = payment?.type === 'cod';
    if (isCod && scheduledStartAt) {
      return { ok: false, error: 'Cash on delivery is only for ASAP orders. Pay online to schedule a later slot.' };
    }
    const totals = calcCartTotals(cart, quote?.fee ?? currentDeliveryFee(get()));
    const hub = useCatalogStore.getState().hub;
    const hubId = user.homeHubId || hub?.id;

    // Snapshot cart so we can restore if payment fails after booking.
    const cartSnapshot = cart.map((c) => ({ ...c }));

    try {
      let orderId = pendingOrderId ?? undefined;
      let bookingOrder: Order | undefined;

      // A pending online hold cannot become a COD booking — release it first.
      if (isCod && orderId) {
        await callCancelBooking(orderId, 'Switched to cash on delivery').catch(() => undefined);
        orderId = undefined;
        set({ pendingOrderId: null });
      }

      // Resume unpaid hold if we already created a booking this session.
      if (!orderId) {
        if (!cartSnapshot.length) return { ok: false, error: 'Cart is empty' };
        if (!opts?.termsVersion) {
          return { ok: false, error: 'Please accept the Terms & Conditions to place your order.' };
        }
        const booking = await callCreateBooking({
          termsVersion: opts.termsVersion,
          hubId,
          cart: cartSnapshot,
          addressLabel: address.label || 'Home',
          addressFull: [
            address.line1,
            address.line2,
            address.area,
            address.city,
            address.pincode,
          ]
            .filter(Boolean)
            .join(', '),
          // Exact pin travels with the order — rider navigates to the doorstep.
          ...(Number.isFinite(address.lat) && Number.isFinite(address.lng)
            ? { dropoffLat: address.lat as number, dropoffLng: address.lng as number }
            : {}),
          paymentMethodLabel: isCod ? 'Cash on Delivery' : 'Razorpay',
          subtotal: totals.itemsTotal,
          taxes: totals.taxes,
          total: totals.total,
          startAt,
          payOnDelivery: isCod,
        });
        orderId = booking.orderId;
        bookingOrder = booking.order as Order;
        set({
          pendingOrderId: orderId,
          orders: [bookingOrder, ...get().orders.filter((o) => o.id !== orderId)],
        });
      }

      // Cash on delivery: order is confirmed now, money moves at handover.
      if (isCod) {
        set({
          cart: [],
          lastOrderId: orderId!,
          paymentError: null,
          pendingOrderId: null,
          scheduledStartAt: null,
          orders: get().orders.map((o) =>
            o.id === orderId
              ? {
                  ...o,
                  status: 'confirmed',
                  paymentStatus: 'cod',
                  paymentProvider: 'cod',
                  paymentMethodLabel: 'Cash on Delivery',
                  progressPercent: 20,
                }
              : o
          ),
        });
        return { ok: true, orderId };
      }

      const rzp = await callCreateRazorpayOrder(orderId!);
      const useDemo = Boolean(rzp.demo || !rzp.keyId);

      if (useDemo) {
        const paid = await callConfirmPayment(orderId!, fail, 'demo');
        if (!paid.ok) {
          set({
            paymentError: paid.error ?? 'Payment failed',
            pendingOrderId: null,
            cart: get().cart.length ? get().cart : cartSnapshot,
          });
          return { ok: false, error: paid.error ?? 'Payment failed', orderId };
        }
      } else if (typeof window !== 'undefined') {
        const proof = await openRazorpayCheckout({
          keyId: rzp.keyId,
          amount: rzp.amount,
          currency: rzp.currency,
          razorpayOrderId: rzp.razorpayOrderId,
          orderId: orderId!,
          name: user.name,
          phone: user.phone,
        });
        await callConfirmPayment(orderId!, false, 'razorpay', proof);
      } else {
        throw new Error('Online payment needs a browser — open PlayPort on the web.');
      }

      const paidLabel = useDemo ? '' : 'Razorpay';
      set({
        cart: [],
        lastOrderId: orderId!,
        paymentError: null,
        pendingOrderId: null,
        scheduledStartAt: null,
        orders: get().orders.map((o) =>
          o.id === orderId
            ? {
                ...o,
                paymentStatus: 'paid',
                progressPercent: 20,
                status: 'confirmed',
                ...(useDemo
                  ? { paymentMethodLabel: '', paymentProvider: 'demo' as const }
                  : paidLabel
                    ? { paymentMethodLabel: paidLabel, paymentProvider: 'razorpay' as const }
                    : {}),
              }
            : o
        ),
      });
      return { ok: true, orderId };
    } catch (e) {
      const message = formatFunctionsError(e);
      set({
        paymentError: message,
        cart: get().cart.length ? get().cart : cartSnapshot,
      });
      return { ok: false, error: message, orderId: get().pendingOrderId ?? undefined };
    }
  },

  cancelOrder: async (orderId, reason) => {
    await callCancelBooking(orderId, reason);
    set({
      orders: get().orders.map((o) =>
        o.id === orderId ? { ...o, status: 'cancelled', progressPercent: 0 } : o
      ),
    });
  },

  applyOrderExtension: (orderId, patch) => {
    set({
      orders: get().orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o)),
    });
  },

  markNotificationRead: (id) => {
    set({
      notifications: get().notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) void markNotificationReadRemote(uid, id).catch(() => {});
  },

  markAllNotificationsRead: () => {
    set({ notifications: get().notifications.map((n) => ({ ...n, read: true })) });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) void markAllNotificationsReadRemote(uid).catch(() => {});
  },

  addReview: (review) => {
    const entry: Review = {
      ...review,
      id: `rev-${Date.now()}`,
      dateLabel: 'Just now',
      userName: get().user?.name ?? 'You',
      userId: get().user?.id,
      createdAt: new Date().toISOString(),
    };
    set({ reviews: [entry, ...get().reviews] });
    const uid = get().user?.id;
    if (uid && get().isAuthenticated) {
      void createReviewDoc({
        ...entry,
        userId: uid,
        createdAt: entry.createdAt!,
      }).catch(() => {});
    }
  },

  loadReviews: async () => {
    try {
      const reviews = await fetchReviews();
      set({ reviews });
    } catch {
      /* keep local */
    }
  },

  pushRecentSearch: (query) => {
    const q = query.trim();
    if (!q) return;
    const rest = get().recentSearches.filter((s) => s.toLowerCase() !== q.toLowerCase());
    set({ recentSearches: [q, ...rest].slice(0, 8) });
  },

  clearRecentSearches: () => set({ recentSearches: [] }),

  clearPaymentError: () => set({ paymentError: null }),
}));

export function useCartCount() {
  return useAppStore((s) => s.cart.reduce((n, i) => n + i.quantity, 0));
}

/** Cache key for a delivery quote — the address and its exact pin. */
function deliveryQuoteKey(address?: Address | null): string | null {
  if (!address || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) return null;
  return `${address.id}:${(address.lat as number).toFixed(5)},${(address.lng as number).toFixed(5)}`;
}

function currentDeliveryFee(state: Pick<AppState, 'addresses' | 'selectedAddressId' | 'deliveryQuote'>): number {
  const address = state.addresses.find((a) => a.id === state.selectedAddressId) ?? state.addresses[0];
  const key = deliveryQuoteKey(address);
  return key && state.deliveryQuote?.key === key ? state.deliveryQuote.fee : 0;
}

export function useCartTotals() {
  const cart = useAppStore((s) => s.cart);
  const fee = useAppStore((s) => currentDeliveryFee(s));
  return calcCartTotals(cart, fee);
}
