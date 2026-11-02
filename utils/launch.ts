import type { Experience, InventoryUnit, Product } from '@/types';
import { asapStart, launchStart } from '@/utils/serviceHours';

/** Unit can be booked for a rental starting at `startIso` (null = ASAP). */
export function unitBookableFor(
  unit: Pick<InventoryUnit, 'status' | 'availableFrom'>,
  startIso: string | null | undefined,
  now = new Date()
): boolean {
  if (unit.status !== 'available') return false;
  const from = launchStart(unit.availableFrom);
  if (!from) return true;
  const start = startIso ? new Date(startIso) : asapStart(now);
  return Number.isFinite(start.getTime()) && start.getTime() >= from.getTime();
}

const launchDayFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
});

/** Launch start for a product that hasn't launched yet; null once it's live. */
export function upcomingLaunch(product: Pick<Product, 'availableFrom'> | null | undefined, now = new Date()): Date | null {
  const start = launchStart(product?.availableFrom);
  return start && start.getTime() > now.getTime() ? start : null;
}

/** "19 Nov" */
export function formatLaunchDay(date: Date): string {
  return launchDayFmt.format(date);
}

/**
 * Earliest start for an order holding these products/combos: the latest
 * upcoming launch among them (one start time covers the whole order).
 */
export function orderNotBefore(
  lines: { productId?: string; experienceId?: string }[],
  products: Product[],
  experiences: Experience[],
  now = new Date()
): Date | null {
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.productId) ids.add(line.productId);
    if (line.experienceId) {
      for (const id of experiences.find((e) => e.id === line.experienceId)?.productIds ?? []) ids.add(id);
    }
  }
  let latest: Date | null = null;
  for (const id of ids) {
    const start = upcomingLaunch(products.find((p) => p.id === id), now);
    if (start && (!latest || start > latest)) latest = start;
  }
  return latest;
}
