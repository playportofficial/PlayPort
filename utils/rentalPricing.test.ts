import { describe, expect, it } from 'vitest';
import type { Product } from '@/types';
import {
  addonsTotal,
  cheapestPlanPrice,
  computeAddonLines,
  defaultExtraControllerAddon,
  defaultPlan,
  describeControllerPrice,
  isControllerAddon,
  normalizeProduct,
  priceForAddon,
  priceForAddonTier,
  priceForHourly,
  resolveHours,
} from './rentalPricing';

const product = (overrides: Partial<Product> = {}): Product =>
  ({
    id: 'ps5',
    name: 'PlayStation 5',
    shortName: 'PS5',
    description: '',
    categoryId: 'gaming',
    images: [],
    plans: [
      { id: '3h', label: '3 Hours', hours: 3, price: 449, popular: true },
      { id: '6h', label: '6 Hours', hours: 6, price: 699 },
      { id: '12h', label: '12 Hours', hours: 12, price: 1099 },
    ],
    hourly: { enabled: true, firstHourPrice: 249, extraHourPrice: 150, maxHours: 24 },
    addons: [defaultExtraControllerAddon()],
    rating: 4.9,
    reviewCount: 1,
    tags: [],
    etaMinutes: 30,
    availabilityLabel: '',
    ...overrides,
  }) as Product;

describe('plans', () => {
  it('normalizeProduct sorts plans and defaults missing fields', () => {
    const p = normalizeProduct(product());
    expect(p.plans.map((x) => x.hours)).toEqual([3, 6, 12]);
    expect(p.hourly).not.toBeUndefined();
    expect(p.addons).toHaveLength(1);
  });
  it('defaultPlan prefers popular, cheapestPlanPrice skips free plans', () => {
    expect(defaultPlan(product())?.id).toBe('3h');
    expect(cheapestPlanPrice(product())).toBe(449);
    expect(cheapestPlanPrice(product({ plans: [] }))).toBeNull();
  });
  it('priceForHourly charges first hour + extras, clamped to max', () => {
    expect(priceForHourly(product(), 1)).toBe(249);
    expect(priceForHourly(product(), 3)).toBe(249 + 2 * 150);
    expect(priceForHourly(product(), 99)).toBe(249 + 23 * 150);
    expect(priceForHourly(product({ hourly: null }), 3)).toBe(0);
  });
});

describe('controller addon tiers (₹100 ≤6h · ₹120 ≤12h · ₹150 ≤24h)', () => {
  const addon = defaultExtraControllerAddon();
  it('picks the smallest covering tier', () => {
    expect(priceForAddonTier(addon.pricing.tiers, 3)).toBe(100);
    expect(priceForAddonTier(addon.pricing.tiers, 6)).toBe(100);
    expect(priceForAddonTier(addon.pricing.tiers, 12)).toBe(120);
  });
  it('falls back to the largest tier and multiplies by quantity', () => {
    expect(priceForAddon(addon, 24, 2)).toBe(300);
    expect(priceForAddon(addon, 3, 0)).toBe(0);
  });
  it('describes itself in plain language', () => {
    expect(describeControllerPrice(addon)).toContain('₹100 up to 6h');
  });
  it('detects controller addons by id or name', () => {
    expect(isControllerAddon({ id: 'extra-controller', name: 'x' })).toBe(true);
    expect(isControllerAddon({ id: 'cover', name: 'Carry Case' })).toBe(false);
  });
});

describe('cart math helpers', () => {
  it('computeAddonLines clamps to maxQuantity and rounds unit price', () => {
    const lines = computeAddonLines(product(), 3, [{ id: 'extra-controller', quantity: 9 }]);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].unitPrice).toBe(100);
    expect(computeAddonLines(product(), 3, [{ id: 'nope', quantity: 1 }])).toHaveLength(0);
  });
  it('addonsTotal sums unit × qty', () => {
    expect(addonsTotal([{ id: 'a', name: 'A', quantity: 2, unitPrice: 100 }])).toBe(200);
    expect(addonsTotal()).toBe(0);
  });
  it('resolveHours follows mode, plan, and hourly caps', () => {
    const p = product();
    expect(resolveHours(p, 'package', '6h')).toBe(6);
    expect(resolveHours(p, 'package', 'missing')).toBe(12);
    expect(resolveHours(p, 'hourly', 'hourly', 5)).toBe(5);
    expect(resolveHours(p, 'hourly', 'hourly', 99)).toBe(24);
  });
});
