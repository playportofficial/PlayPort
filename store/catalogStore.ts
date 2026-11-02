import { create } from 'zustand';
import {
  fetchActiveHubs,
  fetchExperiences,
  fetchInventoryUnitsForHub,
  fetchProducts,
  resolveDefaultHub,
  watchInventoryUnitsForHub,
  watchOrderingStatus,
} from '@/lib/firestore';
import type { Experience, HubInfo, InventoryUnit, Product } from '@/types';
import { normalizeProduct } from '@/utils/rentalPricing';

const EMPTY_HUB: HubInfo = {
  id: 'pending',
  name: 'PlayPort',
  city: '—',
  state: '',
  etaMinutes: 30,
  active: true,
};

interface CatalogState {
  ready: boolean;
  source: 'firestore' | 'empty' | 'error';
  products: Product[];
  experiences: Experience[];
  hub: HubInfo;
  hubs: HubInfo[];
  units: InventoryUnit[];
  error: string | null;
  /** Admin → Settings "Pause ordering": browsing stays on, new orders are blocked. */
  orderingPaused: boolean;
  orderingPausedMessage: string;
  hydrate: () => Promise<void>;
  setActiveHub: (hubId: string) => Promise<void>;
  unitsForProduct: (productId: string) => InventoryUnit[];
  availabilityLabelFor: (productId: string) => string;
}

const DISALLOWED_TAGS = /deposit|digilocker|kyc/i;

let orderingUnsub: (() => void) | null = null;
let unitsWatch: { hubId: string; unsub: () => void } | null = null;

function sanitizeProduct(p: Product): Product {
  return {
    ...p,
    tags: (p.tags ?? []).filter((t) => !DISALLOWED_TAGS.test(t)),
  };
}

function enrichProducts(products: Product[], units: InventoryUnit[]): Product[] {
  return products.map((raw) => {
    const p = normalizeProduct(sanitizeProduct(raw));
    const forProduct = units.filter((u) => u.productId === p.id);
    if (!forProduct.length) return p;
    const n = forProduct.filter((u) => u.status === 'available').length;
    return {
      ...p,
      availabilityLabel: n > 0 ? `${n} units at hub` : 'No units at hub',
    };
  });
}

type CatalogSet = (partial: Partial<CatalogState>) => void;

function watchUnits(hubId: string, set: CatalogSet, get: () => CatalogState) {
  if (unitsWatch?.hubId === hubId) return;
  unitsWatch?.unsub();
  unitsWatch = {
    hubId,
    unsub: watchInventoryUnitsForHub(hubId, (units) => {
      if (get().hub.id !== hubId) return;
      set({ units, products: enrichProducts(get().products, units) });
    }),
  };
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  ready: false,
  source: 'empty',
  products: [],
  experiences: [],
  hub: EMPTY_HUB,
  hubs: [],
  units: [],
  error: null,
  orderingPaused: false,
  orderingPausedMessage: '',

  unitsForProduct: (productId) =>
    get().units.filter((u) => u.productId === productId && u.status === 'available'),

  availabilityLabelFor: (productId) => {
    const count = get().unitsForProduct(productId).length;
    if (!get().units.length) {
      const product = get().products.find((p) => p.id === productId);
      return product?.availabilityLabel ?? 'Check availability';
    }
    if (count <= 0) return 'No units at hub';
    return `${count} units at hub`;
  },

  setActiveHub: async (hubId) => {
    const hub = get().hubs.find((h) => h.id === hubId) ?? (await resolveDefaultHub(hubId));
    if (!hub) return;
    const units = await fetchInventoryUnitsForHub(hub.id);
    set({ hub, units, products: enrichProducts(get().products, units) });
    watchUnits(hub.id, set, get);
  },

  hydrate: async () => {
    if (!orderingUnsub) {
      orderingUnsub = watchOrderingStatus(({ paused, message }) =>
        set({ orderingPaused: paused, orderingPausedMessage: message })
      );
    }
    try {
      const [products, experiences, hubs] = await Promise.all([
        fetchProducts(),
        fetchExperiences(),
        fetchActiveHubs(),
      ]);

      const hubList = hubs.length ? hubs : [];
      const hub = hubList[0] ?? EMPTY_HUB;
      const units = hubList.length ? await fetchInventoryUnitsForHub(hub.id) : [];

      set({
        ready: true,
        source: products.length || experiences.length ? 'firestore' : 'empty',
        products: enrichProducts(products, units),
        experiences,
        hubs: hubList,
        hub,
        units,
        error: products.length
          ? null
          : 'No products in the store yet. Add them in Admin → Products.',
      });
      if (hubList.length) watchUnits(hub.id, set, get);
    } catch (e) {
      // Never ship mock SKUs — show empty catalog + error.
      set({
        ready: true,
        source: 'error',
        products: [],
        experiences: [],
        hubs: [],
        hub: EMPTY_HUB,
        units: [],
        error:
          e instanceof Error
            ? e.message
            : 'Could not load catalog. Check your connection and try again.',
      });
    }
  },
}));
