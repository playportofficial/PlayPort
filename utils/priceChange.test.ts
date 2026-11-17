import { describe, expect, it } from 'vitest';
import type { CartItem, Product, RentalPlan } from '@/types';
import { productForStart as fnProductForStart } from '../functions/src/rentalPricing';
import { productForStart, repriceCartForStart, upcomingPriceChange } from './priceChange';

const plan = (id: string, hours: number, price: number): RentalPlan => ({ id, label: `${hours} Hours`, hours, price });
const ps5 = {
  id: 'ps5-slim-digital',
  plans: [plan('1h', 1, 249), plan('3h', 3, 499), plan('24h', 24, 1499)],
  priceChange: {
    from: '2026-11-18',
    plans: [
      plan('1h', 1, 499),
      plan('3h', 3, 999),
      plan('12h', 12, 2499),
      plan('24h', 24, 3999),
    ],
  },
} as unknown as Product;

const now = new Date('2026-10-29T06:36:00Z'); // 29 Oct, 12:06 PM IST
const nov17Night = '2026-11-17T17:30:00Z'; // 17 Nov, 11 PM IST
const nov18Morning = '2026-11-18T02:30:00Z'; // 18 Nov, 8 AM IST

describe('productForStart', () => {
  it('keeps today’s prices for ASAP and for slots before 18 Nov', () => {
    expect(productForStart(ps5, null, now).plans[1].price).toBe(499);
    expect(productForStart(ps5, nov17Night, now).plans[1].price).toBe(499);
  });
  it('uses GTA package prices for slots from 18 Nov (12h ₹2499 / 24h ₹3999)', () => {
    const priced = productForStart(ps5, nov18Morning, now);
    expect(priced.plans.find((p) => p.id === '3h')?.price).toBe(999);
    expect(priced.plans.find((p) => p.id === '12h')?.price).toBe(2499);
    expect(priced.plans.find((p) => p.id === '24h')?.price).toBe(3999);
  });
  it('switches ASAP over automatically once 18 Nov arrives', () => {
    expect(productForStart(ps5, null, new Date(nov18Morning)).plans[0].price).toBe(499);
    expect(upcomingPriceChange(ps5, new Date(nov18Morning))).toBeNull();
  });
  it('matches the server', () => {
    for (const start of [nov17Night, nov18Morning]) {
      expect(fnProductForStart(ps5 as Parameters<typeof fnProductForStart>[0], new Date(start).getTime()).plans).toEqual(
        productForStart(ps5, start, now).plans
      );
    }
  });
});

describe('repriceCartForStart', () => {
  const line = { id: 'a', productId: 'ps5-slim-digital', planId: '3h', pricingMode: 'package', unitPrice: 499, durationLabel: '3 Hours', hours: 3, quantity: 1 } as CartItem;
  it('re-prices when the slot moves past 18 Nov and back', () => {
    const later = repriceCartForStart([line], [ps5], nov18Morning, now);
    expect(later[0].unitPrice).toBe(999);
    expect(repriceCartForStart(later, [ps5], nov17Night, now)[0].unitPrice).toBe(499);
  });
  it('returns the same cart when nothing changes', () => {
    const cart = [line];
    expect(repriceCartForStart(cart, [ps5], nov17Night, now)).toBe(cart);
  });
});
