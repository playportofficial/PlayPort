/** Service-hours + scheduling rules (IST). Open 6 AM – midnight, closed 12–6 AM. */

export const SERVICE_OPEN_HOUR = 6;
export const SERVICE_CLOSE_HOUR = 24; // midnight
/** From this IST hour onward, only packages up to NIGHT_MAX_HOURS are bookable. */
export const NIGHT_START_HOUR = 18; // 6 PM
/** Night bookings are capped at 6h (no 12h/24h overnight loopholes). */
export const NIGHT_MAX_HOURS = 6;
export const SCHEDULE_LEAD_MINUTES = 45;
export const MAX_ADVANCE_DAYS = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function istDate(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

export function istHour(date: Date): number {
  return istDate(date).getUTCHours();
}

/** True when dropoffs are running right now (6:00 AM – 12:00 AM IST). */
export function isServiceOpen(now = new Date()): boolean {
  const h = istHour(now);
  return h >= SERVICE_OPEN_HOUR && h < SERVICE_CLOSE_HOUR;
}

export function asapStart(now = new Date()): Date {
  return new Date(now.getTime() + SCHEDULE_LEAD_MINUTES * 60 * 1000);
}

/** Start-of-day (IST) for the given date's IST calendar day. */
function istDayStart(date: Date): Date {
  const d = istDate(date);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST_OFFSET_MS);
}

export interface ScheduleDay {
  key: string;
  label: string;
  sub: string;
  date: Date;
}

const dayFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/**
 * Earliest start for a pre-book product: "2026-11-19" means 12:00 AM IST that
 * day (full ISO timestamps are honoured as-is). Null when unset or unreadable.
 */
export function launchStart(availableFrom?: string | null): Date | null {
  if (!availableFrom) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(availableFrom.trim());
  const ms = day
    ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - IST_OFFSET_MS
    : new Date(availableFrom).getTime();
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Days in the bookable range that still have at least one slot. */
export function availableDays(now = new Date(), notBefore?: Date | null): ScheduleDay[] {
  const days: ScheduleDay[] = [];
  for (let i = 0; i < MAX_ADVANCE_DAYS; i++) {
    const base = new Date(istDayStart(now).getTime() + i * DAY_MS);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayFmt.format(base).split(',')[0];
    days.push({
      key: base.toISOString(),
      label,
      sub: dayFmt.format(base),
      date: base,
    });
  }
  return days.filter((d) => daySlots(d.date, now, notBefore).length > 0);
}

/** Key of the IST calendar day containing `date` (matches `ScheduleDay.key`). */
export function scheduleDayKey(date: Date): string {
  return istDayStart(date).toISOString();
}

export interface CalendarCell {
  key: string;
  day: number;
  date: Date;
  available: boolean;
  isToday: boolean;
}

export interface CalendarMonth {
  key: string;
  label: string;
  /** Sunday-first grid; `null` pads the days before the 1st. */
  cells: (CalendarCell | null)[];
}

const monthFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});

/** IST month grids covering today through the last bookable day. */
export function calendarMonths(now = new Date(), notBefore?: Date | null): CalendarMonth[] {
  const bookable = new Set(availableDays(now, notBefore).map((d) => d.key));
  const todayStart = istDayStart(now);
  const todayKey = todayStart.toISOString();
  const first = istDate(todayStart);
  const last = istDate(new Date(todayStart.getTime() + (MAX_ADVANCE_DAYS - 1) * DAY_MS));
  const months: CalendarMonth[] = [];
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  while (y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth())) {
    const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells: (CalendarCell | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d++) {
      const date = new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
      const key = date.toISOString();
      cells.push({ key, day: d, date, available: bookable.has(key), isToday: key === todayKey });
    }
    months.push({ key: `${y}-${m}`, label: monthFmt.format(new Date(Date.UTC(y, m, 15))), cells });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return months;
}

/** "Mon, 26 Oct" */
export function formatScheduleDay(date: Date): string {
  return dayFmt.format(date);
}

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Hourly dropoff slots 6 AM – 11 PM IST for a day; today filters past + lead time. */
export function daySlots(dayStart: Date, now = new Date(), notBefore?: Date | null): Date[] {
  const slots: Date[] = [];
  const minStart = Math.max(now.getTime() + SCHEDULE_LEAD_MINUTES * 60 * 1000, notBefore?.getTime() ?? 0);
  for (let h = SERVICE_OPEN_HOUR; h < SERVICE_CLOSE_HOUR; h++) {
    const slot = new Date(dayStart.getTime() + h * 60 * 60 * 1000);
    if (slot.getTime() < minStart) continue;
    slots.push(slot);
  }
  return slots;
}

/** A scheduled start is valid when: in the future (+lead), inside 6 AM–12 AM IST, within MAX_ADVANCE_DAYS. */
export function isValidScheduledStart(
  iso: string | null | undefined,
  now = new Date(),
  hours?: number,
  notBefore?: Date | null
): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  if (t < now.getTime() + SCHEDULE_LEAD_MINUTES * 60 * 1000) return false;
  if (notBefore && t < notBefore.getTime()) return false;
  const h = istHour(new Date(t));
  if (h < SERVICE_OPEN_HOUR || h >= SERVICE_CLOSE_HOUR) return false;
  if (t > now.getTime() + MAX_ADVANCE_DAYS * DAY_MS) return false;
  if (hours != null && !rentalEndsInServiceHours(new Date(t), hours)) return false;
  return true;
}

/**
 * Pickup rules (IST):
 * - Daytime starts (before 6 PM): rental must end in service hours (6 AM – midnight).
 * - Night starts (6 PM onward): only packages up to 6h — overnight ending before
 *   6 AM is fine; the rider picks up at open. No 12h/24h night bookings.
 */
export function rentalEndsInServiceHours(start: Date, hours: number): boolean {
  if (!Number.isFinite(hours) || hours <= 0) return false;
  const startH = istHour(start);
  if (startH >= NIGHT_START_HOUR) {
    return hours <= NIGHT_MAX_HOURS;
  }
  const end = istDate(new Date(start.getTime() + hours * 60 * 60 * 1000));
  return end.getUTCHours() >= SERVICE_OPEN_HOUR;
}

/** ASAP is offered only while open, after any launch date, and when the rental would end in service hours. */
export function isAsapAvailable(now: Date, hours: number, notBefore?: Date | null): boolean {
  if (notBefore && asapStart(now).getTime() < notBefore.getTime()) return false;
  return isServiceOpen(now) && rentalEndsInServiceHours(asapStart(now), hours);
}

const dayTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const shortTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  hour12: true,
});

/** "Today, 4:00 PM" */
export function formatSlot(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = istDayStart(d).getTime() === istDayStart(now).getTime();
  const tomorrow =
    istDayStart(d).getTime() === istDayStart(now).getTime() + 24 * 60 * 60 * 1000;
  const prefix = sameDay ? 'Today' : tomorrow ? 'Tomorrow' : dayFmt.format(d);
  return `${prefix}, ${timeFmt.format(d)}`;
}

/** "4:00 pm" — time only, for slot chips under a chosen day. */
export function formatSlotTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** "4 PM – 4 AM" window for a start + duration. */
export function formatWindow(startIso: string, hours: number): string {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  return `${clockTime(start)} – ${clockTime(end)}`;
}

/** "4 pm" on the hour, "3:59 pm" otherwise — never hide the minutes. */
function clockTime(date: Date): string {
  return istDate(date).getUTCMinutes() === 0 ? shortTimeFmt.format(date) : timeFmt.format(date);
}

/** Next opening time (6 AM IST) when currently closed. */
export function nextOpenStart(now = new Date()): Date {
  const dayStart = istDayStart(now);
  const openAt = new Date(dayStart.getTime() + SERVICE_OPEN_HOUR * 60 * 60 * 1000);
  return openAt.getTime() > now.getTime()
    ? openAt
    : new Date(openAt.getTime() + 24 * 60 * 60 * 1000);
}

/** How early (before startAt) a job enters the rider pool. */
export const DISPATCH_LEAD_MINUTES = 60;

/**
 * How long after startAt a job stays in the rider pool. A booking is a *delivery
 * slot*, not a rental window: a PS5 booked for 11 AM is late by 11:01 AM, even
 * though the 24h rental would run until the next morning. Gating on `endAt` kept
 * long rentals claimable for a whole day behind a stale "Starts … 11:13 AM" label.
 */
export const DISPATCH_GRACE_MINUTES = 90;

/**
 * Rider-pool gating: an unclaimed order is claimable only inside its delivery
 * slot — from DISPATCH_LEAD_MINUTES before startAt until DISPATCH_GRACE_MINUTES
 * after it. Orders flagged expired by ops/system are never claimable, and legacy
 * orders without a readable start stay visible.
 *
 * This is the app-side mirror of the server's claimRun dispatchability check.
 */
export function isDispatchable(
  order: { startAt?: string; endAt?: string; expiredAt?: string | null } | null | undefined,
  now = new Date()
): boolean {
  if (!order) return false;

  // If ops/system already marked the order expired, it is not in the rider pool.
  if (order.expiredAt) return false;

  // Legacy orders predate scheduled starts — keep them visible.
  if (!order.startAt) return true;
  const start = new Date(order.startAt).getTime();
  if (!Number.isFinite(start)) return true;

  const nowMs = now.getTime();
  if (start > nowMs + DISPATCH_LEAD_MINUTES * 60 * 1000) return false; // too early to dispatch
  if (nowMs > start + DISPATCH_GRACE_MINUTES * 60 * 1000) return false; // slot has closed
  return true;
}

export type DeliverySlotState = 'upcoming' | 'late' | 'closed';

export interface DeliverySlot {
  state: DeliverySlotState;
  /** "Today, 11:13 AM" */
  startLabel: string;
  /** "Tomorrow, 11:13 AM" */
  endLabel: string | null;
  /** "Today, 11:13 AM – Tomorrow, 11:13 AM" */
  window: string;
  /** Whole booked hours, e.g. 24. */
  hours: number | null;
  /**
   * Minutes since the booked start — how late the *delivery* is. 0 before it begins.
   * On a multi-hour rental this keeps counting past the window end, so read
   * `overdueMinutes` once `state` is 'closed'.
   */
  lateMinutes: number;
  /** Minutes since the booked window ended; 0 while it is still open. */
  overdueMinutes: number;
  /** One line a rider or ops can act on. */
  note: string;
}

/** "3h 17m" / "45m" — compact lateness. */
export function formatLate(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function parseInstant(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "24 Hours" / "12h" / "6 Hours +1h ext" → whole hours. */
function hoursFromDurationLabel(label?: string | null): number | null {
  if (!label) return null;
  const base = /^(\d+)\s*h(?:ours?)?/i.exec(label.trim());
  if (base) return Number(base[1]);
  const loose = /(\d+)\s*h/i.exec(label);
  return loose ? Number(loose[1]) : null;
}

function hoursFromOrderItems(items?: { durationLabel?: string }[] | null): number | null {
  if (!items?.length) return null;
  let max: number | null = null;
  for (const item of items) {
    const h = hoursFromDurationLabel(item.durationLabel);
    if (h != null) max = max == null ? h : Math.max(max, h);
  }
  return max;
}

/**
 * One rider/ops line for a slot — never shows "25h late" once the booked window
 * has ended (use overdue from the end instead).
 */
export function formatSlotStatus(slot: DeliverySlot, opts?: { withWindow?: boolean }): string {
  const tail = opts?.withWindow ? ` · ${slot.window}` : '';
  if (slot.state === 'upcoming') {
    return `Delivery slot ${slot.window}${slot.hours ? ` · ${slot.hours}h` : ''} · clock starts at handover`;
  }
  // Prefer overdue whenever the window is gone — even if state was forced closed
  // via expiredAt with a readable end.
  if (slot.state === 'closed' || slot.overdueMinutes > 0) {
    return `Window closed ${formatLate(slot.overdueMinutes)} ago${tail}`;
  }
  return `Delivery slot ${slot.startLabel} · ${formatLate(slot.lateMinutes)} late · clock starts at handover`;
}

/**
 * How a booking's *delivery slot* stands right now — the honest label the rider
 * portal shows instead of a bare "Starts Today, 11:13 AM", which reads as future
 * even when the slot is hours gone.
 *
 * Prefers `bookedStartAt` / `bookedEndAt` when present (original appointment), so
 * a slid runtime clock after handover never rewrites the late/closed math.
 */
export function deliverySlot(
  order: {
    startAt?: string;
    endAt?: string;
    bookedStartAt?: string;
    bookedEndAt?: string;
    expiredAt?: string | null;
    items?: { durationLabel?: string }[];
  } | null | undefined,
  now = new Date()
): DeliverySlot | null {
  const startIso = order?.bookedStartAt || order?.startAt;
  if (!startIso) return null;
  const start = parseInstant(startIso);
  if (!start) return null;

  // Original booked end first; fall back to runtime endAt; last resort infer from
  // the line-item duration so a missing endAt can't strand us on "25h late".
  let end = parseInstant(order?.bookedEndAt || order?.endAt);
  const inferredHours = hoursFromOrderItems(order?.items);
  if (!end && inferredHours != null && inferredHours > 0) {
    end = new Date(start.getTime() + inferredHours * 3_600_000);
  }

  const hasEnd = end != null;
  const hours = hasEnd
    ? Math.round((end!.getTime() - start.getTime()) / 3_600_000)
    : inferredHours;
  const startLabel = formatSlot(startIso, now);
  const endLabel = hasEnd ? formatSlot(end!.toISOString(), now) : null;

  const nowMs = now.getTime();
  const windowLabel = endLabel ? `${startLabel} – ${endLabel}` : startLabel;
  const lateMinutes = Math.max(0, Math.round((nowMs - start.getTime()) / 60_000));
  // A 24h rental booked yesterday reads as "25h late" by the time its window closes,
  // which is technically true but useless: what ops and the rider need then is how long
  // the *booked window* has been gone, not how long since it started.
  let overdueMinutes = hasEnd ? Math.max(0, Math.round((nowMs - end!.getTime()) / 60_000)) : 0;

  // If we still have no end but lateness already exceeds a known rental length,
  // treat the surplus as "window closed X ago" instead of "25h late".
  if (!hasEnd && hours != null && hours > 0 && lateMinutes > hours * 60) {
    overdueMinutes = lateMinutes - hours * 60;
  }

  const windowEnded = overdueMinutes > 0;
  const state: DeliverySlotState = order?.expiredAt
    ? 'closed'
    : nowMs < start.getTime()
      ? 'upcoming'
      : windowEnded
        ? 'closed'
        : 'late';

  const duration = hours ? ` · ${hours}h rental` : '';
  const note =
    state === 'upcoming'
      ? `Booked delivery ${startLabel}${duration}. The rental clock starts at handover, not now.`
      : state === 'late'
        ? `Booked delivery ${startLabel} — running ${formatLate(lateMinutes)} late.${
            endLabel ? ` The window closes ${endLabel}.` : ' Ops confirms late dispatches.'
          }`
        : overdueMinutes > 0
          ? `Booked window ${windowLabel} closed ${formatLate(overdueMinutes)} ago. Ops must review this run before anyone delivers it.`
          : 'This order was flagged expired. Ops must review it before anyone delivers it.';

  return {
    state,
    startLabel,
    endLabel,
    window: windowLabel,
    hours,
    lateMinutes,
    overdueMinutes,
    note,
  };
}

/**
 * Ops-only late dispatch: an order whose original slot has just passed may still
 * be dispatched, but only after an ops decision (customer re-agreement, fee,
 * reschedule, or refund). This is used by the admin console, not the rider pool.
 *
 * Returns `null` when the order is clearly not late-dispatchable (too old, already
 * expired, etc.), and a short note when it is.
 */
export function isLateDispatchableByOps(
  order: { startAt?: string; endAt?: string; expiredAt?: string | null; riderId?: string | null } | null | undefined,
  now = new Date()
): { ok: boolean; reason?: string } | null {
  if (!order) return null;
  if (order.expiredAt) {
    return { ok: false, reason: 'This order has already expired.' };
  }
  if (order.riderId) {
    return { ok: false, reason: 'This order already has a rider.' };
  }
  const nowMs = now.getTime();
  const start = order.startAt ? new Date(order.startAt).getTime() : NaN;
  if (!Number.isFinite(start)) {
    // No readable slot — nothing to be late for; use the normal path.
    return null;
  }
  const pastMs = nowMs - start;
  if (pastMs <= DISPATCH_GRACE_MINUTES * 60 * 1000) {
    // Still inside the normal dispatch window — use the normal path.
    return null;
  }
  const STALE_DISPATCH_MS = 3 * 60 * 60 * 1000;
  if (pastMs > STALE_DISPATCH_MS) {
    return { ok: false, reason: 'This order’s slot passed too long ago to dispatch as-is.' };
  }
  return { ok: true };
}

export { dayTimeFmt };
