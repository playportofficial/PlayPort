/** Service-hours + scheduling rules (IST). Open 8 AM – midnight, closed 12–8 AM. */

export const SERVICE_OPEN_HOUR = 8;
export const SERVICE_CLOSE_HOUR = 24; // midnight
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

/** True when dropoffs are running right now (8:00 AM – 12:00 AM IST). */
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

/** Hourly dropoff slots 8 AM – 11 PM IST for a day; today filters past + lead time. */
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

/** A scheduled start is valid when: in the future (+lead), inside 8 AM–12 AM IST, within MAX_ADVANCE_DAYS. */
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
 * Pickups run in service hours too, so a rental must end between 8:00 AM and
 * 11:59 PM IST — e.g. a 3h rental starts by 8 PM, an 11 PM start needs 12h.
 */
export function rentalEndsInServiceHours(start: Date, hours: number): boolean {
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

/** Next opening time (8 AM IST) when currently closed. */
export function nextOpenStart(now = new Date()): Date {
  const dayStart = istDayStart(now);
  const eightAm = new Date(dayStart.getTime() + SERVICE_OPEN_HOUR * 60 * 60 * 1000);
  return eightAm.getTime() > now.getTime()
    ? eightAm
    : new Date(eightAm.getTime() + 24 * 60 * 60 * 1000);
}

/** How early (before startAt) a job enters the rider pool. */
export const DISPATCH_LEAD_MINUTES = 60;

/**
 * Rider-pool gating: an unclaimed order is claimable when its window hasn't
 * ended and its start is within the dispatch lead (or unscheduled legacy).
 */
export function isDispatchable(
  order: { startAt?: string; endAt?: string } | null | undefined,
  now = new Date()
): boolean {
  if (!order) return false;
  const nowMs = now.getTime();
  if (order.endAt) {
    const end = new Date(order.endAt).getTime();
    if (Number.isFinite(end) && end < nowMs) return false;
  }
  if (!order.startAt) return true;
  const start = new Date(order.startAt).getTime();
  if (!Number.isFinite(start)) return true;
  return start <= nowMs + DISPATCH_LEAD_MINUTES * 60 * 1000;
}

export { dayTimeFmt };
