/** Pure pricing helpers mirrored for Cloud Functions (keep in sync with utils/rentalPricing.ts). */

export type FnRentalPlan = {
  id: string;
  label: string;
  hours: number;
  price: number;
  popular?: boolean;
};

export type FnHourly = {
  enabled: boolean;
  firstHourPrice: number;
  extraHourPrice: number;
  maxHours?: number;
};

export type FnAddon = {
  id: string;
  name: string;
  maxQuantity: number;
  pricing: {
    perHour: number;
    perHourMaxPlanHours: number;
    flatPrice: number;
    flatMinPlanHours: number;
    tiers?: { upToHours: number; price: number; mode?: 'flat' | 'hourly' }[];
  };
};

export type FnProduct = {
  id: string;
  plans?: FnRentalPlan[];
  hourly?: FnHourly | null;
  addons?: FnAddon[];
  priceByDuration?: Record<string, number>;
  /** Rentals starting on/after `from` (IST day "YYYY-MM-DD") use these plans. */
  priceChange?: { from: string; plans: FnRentalPlan[] } | null;
};

/** "YYYY-MM-DD" = 12:00 AM IST that day; full ISO strings as-is. Mirrors utils/serviceHours launchStart. */
export function istDayStartMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const ms = day
    ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - 5.5 * 60 * 60 * 1000
    : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The product as priced for a rental starting at `startMs`. Mirrors utils/priceChange productForStart. */
export function productForStart<T extends FnProduct>(product: T, startMs: number): T {
  const change = product.priceChange;
  if (!change?.plans?.length) return product;
  const from = istDayStartMs(change.from);
  if (from == null || startMs < from) return product;
  return { ...product, plans: change.plans };
}

export type FnCartAddon = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
};

export type FnCartItem = {
  productId?: string;
  experienceId?: string;
  planId?: string;
  durationId?: string;
  hours?: number;
  pricingMode?: 'package' | 'hourly';
  unitPrice: number;
  quantity: number;
  addons?: FnCartAddon[];
  addonsTotal?: number;
  inventoryUnitId?: string;
};

function legacyPlans(map?: Record<string, number>): FnRentalPlan[] {
  if (!map) return [];
  const hoursFor: Record<string, number> = {
    '1h': 1,
    '3h': 3,
    '4h': 4,
    '6h': 6,
    '12h': 12,
    '24h': 24,
    weekend: 48,
  };
  return Object.entries(map).map(([id, price]) => ({
    id,
    label: id,
    hours: hoursFor[id] ?? 12,
    price: Number(price) || 0,
  }));
}

export function normalizeFnProduct(raw: FnProduct): FnProduct & { plans: FnRentalPlan[] } {
  const plans = raw.plans?.length ? raw.plans : legacyPlans(raw.priceByDuration);
  return { ...raw, plans };
}

export function priceForPlan(product: FnProduct, planId: string): number {
  const plan = normalizeFnProduct(product).plans.find((x) => x.id === planId);
  return plan?.price ?? 0;
}

export function priceForHourly(product: FnProduct, hours: number): number {
  const h = product.hourly;
  if (!h?.enabled || hours < 1) return 0;
  const max = h.maxHours ?? 24;
  const n = Math.min(Math.max(1, Math.floor(hours)), max);
  if (n === 1) return h.firstHourPrice;
  return h.firstHourPrice + (n - 1) * h.extraHourPrice;
}

/**
 * Extra-controller options for a combo: the combo's own add-ons when it has them,
 * otherwise those of the consoles it includes. Mirrors utils/rentalPricing
 * experienceAddonOptions so the server prices exactly what the app showed.
 */
export function experienceAddonOptions(
  experience: { addons?: FnAddon[]; productIds?: string[] } | null | undefined,
  products: { id: string; addons?: FnAddon[] }[]
): FnAddon[] {
  const isController = (addon: FnAddon) =>
    addon.id === 'extra-controller' || /controller/i.test(addon.name);

  const own = (experience?.addons ?? []).filter(isController);
  if (own.length) return own;

  const included = new Set(experience?.productIds ?? []);
  const seen = new Set<string>();
  const derived: FnAddon[] = [];
  for (const product of products) {
    if (!included.has(product.id)) continue;
    for (const addon of product.addons ?? []) {
      if (!isController(addon) || seen.has(addon.id)) continue;
      seen.add(addon.id);
      derived.push(addon);
    }
  }
  return derived;
}

export function priceForAddon(addon: FnAddon, hours: number, quantity = 1): number {
  const q = Math.max(0, quantity);
  if (q <= 0) return 0;
  const tiers = (addon.pricing.tiers ?? [])
    .filter((t) => t.upToHours > 0 && t.price >= 0)
    .sort((a, b) => a.upToHours - b.upToHours);
  if (tiers.length) {
    const tier = tiers.find((t) => hours <= t.upToHours) ?? tiers[tiers.length - 1];
    return (tier.mode === 'hourly' ? tier.price * hours : tier.price) * q;
  }
  const { pricing } = addon;
  const useFlat = pricing.flatPrice > 0 && hours >= pricing.flatMinPlanHours;
  const unit = useFlat ? pricing.flatPrice : pricing.perHour * hours;
  return unit * q;
}

export function expectedLineTotal(product: FnProduct | null, item: FnCartItem): number {
  if (!product || item.experienceId) {
    const base = item.unitPrice * item.quantity;
    const extras = (item.addonsTotal ?? 0) * item.quantity;
    return base + extras;
  }
  const mode = item.pricingMode ?? 'package';
  const hours = item.hours ?? 12;
  const planId = item.planId || item.durationId || '';
  const kit =
    mode === 'hourly' ? priceForHourly(product, hours) : priceForPlan(product, planId);
  const catalog = normalizeFnProduct(product).addons ?? [];
  let extras = 0;
  for (const line of item.addons ?? []) {
    const addon = catalog.find((a) => a.id === line.id);
    if (!addon) continue;
    extras += priceForAddon(addon, hours, line.quantity);
  }
  return (kit + extras) * item.quantity;
}

export function cartItemHours(item: FnCartItem): number {
  if (typeof item.hours === 'number' && item.hours > 0) return item.hours;
  return 12;
}
