import { callCheckAvailability } from '@/lib/functions';
import {
  asapStart,
  formatWindow,
  istHour,
  MAX_ADVANCE_DAYS,
  SERVICE_CLOSE_HOUR,
  SERVICE_OPEN_HOUR,
} from '@/utils/serviceHours';
import type { Experience, Product } from '@/types';

export interface SlotCheckItem {
  productId: string;
  hours: number;
  quantity?: number;
  name: string;
}

/**
 * Expand cart/PDP lines into per-product check items. Combos fan out to
 * their linked products (mirroring server-side booking expansion); lines
 * with no resolvable product are skipped.
 */
export function expandCheckItems(
  lines: Array<{ productId?: string; experienceId?: string; hours: number; quantity?: number; name: string }>,
  products: Product[],
  experiences: Experience[]
): SlotCheckItem[] {
  const items: SlotCheckItem[] = [];
  for (const line of lines) {
    if (line.productId) {
      const product = products.find((p) => p.id === line.productId);
      items.push({
        productId: line.productId,
        hours: line.hours,
        quantity: line.quantity ?? 1,
        name: product?.shortName ?? line.name,
      });
      continue;
    }
    if (line.experienceId) {
      const experience = experiences.find((e) => e.id === line.experienceId);
      const linked = experience?.productIds ?? [];
      for (const pid of linked) {
        const product = products.find((p) => p.id === pid);
        items.push({
          productId: pid,
          hours: line.hours,
          quantity: line.quantity ?? 1,
          name: product?.shortName ?? line.name,
        });
      }
    }
  }
  return items;
}

/** Is there a free unit for this product in [start, start+hours)? */
export async function checkSlot(
  productId: string,
  hubId: string | undefined,
  startIso: string,
  hours: number,
  quantity = 1
): Promise<{ free: boolean; totalUnits: number; failed?: boolean }> {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return { free: false, totalUnits: 0, failed: true };
  try {
    const res = await callCheckAvailability({
      productId,
      hubId,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + hours * 60 * 60 * 1000).toISOString(),
      quantity,
    });
    const free = res.ok && (res.availableUnitIds?.length ?? 0) > 0;
    return { free, totalUnits: res.totalUnits ?? 0 };
  } catch {
    return { free: false, totalUnits: 0, failed: true };
  }
}

function startOfNextDay8am(from: Date): Date {
  const d = new Date(from.getTime());
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 60 * 60 * 1000 + (SERVICE_OPEN_HOUR + 24) * 60 * 60 * 1000);
}

/**
 * Probes forward in same-duration steps for the first free window.
 * Rolls to 8 AM next day when the day is exhausted (max ~6 probes).
 * Returns the free start ISO, or null when nothing frees up.
 */
export async function findNextFreeSlot(
  productId: string,
  hubId: string | undefined,
  fromIso: string,
  hours: number,
  quantity = 1,
  now = new Date()
): Promise<string | null> {
  const stepMs = Math.max(1, hours) * 60 * 60 * 1000;
  const deadline = now.getTime() + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000;
  let candidate = new Date(fromIso).getTime() + stepMs;

  for (let i = 0; i < 6; i++) {
    if (candidate > deadline) return null;
    const h = istHour(new Date(candidate));
    if (h < SERVICE_OPEN_HOUR || h >= SERVICE_CLOSE_HOUR) {
      candidate = startOfNextDay8am(new Date(candidate)).getTime();
      if (candidate > deadline) return null;
    }
    const iso = new Date(candidate).toISOString();
    if ((await checkSlot(productId, hubId, iso, hours, quantity)).free) return iso;
    candidate += stepMs;
  }
  return null;
}

/** ASAP window start (now + 45 min). */
export function asapWindowStart(now = new Date()): string {
  return asapStart(now).toISOString();
}

export function windowLabel(startIso: string, hours: number): string {
  return formatWindow(startIso, hours);
}
