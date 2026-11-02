import { describe, expect, it } from 'vitest';
import {
  availableDays,
  calendarMonths,
  daySlots,
  formatSlot,
  formatSlotTime,
  formatWindow,
  isDispatchable,
  isServiceOpen,
  isValidScheduledStart,
  nextOpenStart,
  isAsapAvailable,
  rentalEndsInServiceHours,
} from './serviceHours';

// Fixed reference: Monday 2026-10-12. IST = UTC + 5:30.
const T = (utc: string) => new Date(utc);

describe('isServiceOpen (IST 8 AM – midnight)', () => {
  it('is closed just before 8 AM IST', () => {
    expect(isServiceOpen(T('2026-10-12T02:29:00Z'))).toBe(false); // 7:59 IST
  });
  it('opens exactly at 8 AM IST', () => {
    expect(isServiceOpen(T('2026-10-12T02:30:00Z'))).toBe(true);
  });
  it('is open mid-day and late evening', () => {
    expect(isServiceOpen(T('2026-10-12T06:30:00Z'))).toBe(true); // 12:00 IST
    expect(isServiceOpen(T('2026-10-12T18:29:00Z'))).toBe(true); // 23:59 IST
  });
  it('closes exactly at midnight IST', () => {
    expect(isServiceOpen(T('2026-10-12T18:30:00Z'))).toBe(false); // 00:00 IST next day
    expect(isServiceOpen(T('2026-10-12T20:00:00Z'))).toBe(false); // 1:30 AM IST
  });
});

describe('daySlots', () => {
  it('offers 16 hourly slots (8 AM – 11 PM) for a future day', () => {
    const now = T('2026-10-12T06:00:00Z'); // 11:30 AM IST Monday
    const days = availableDays(now);
    const wed = days.find((d) => d.label !== 'Today' && d.label !== 'Tomorrow')!;
    expect(daySlots(wed.date, now)).toHaveLength(16);
  });
  it('hides past + lead-time slots for today', () => {
    const now = T('2026-10-12T10:00:00Z'); // 3:30 PM IST
    const today = availableDays(now)[0];
    const slots = daySlots(today.date, now);
    // 45-min lead → first bookable is the 5 PM slot (16:00 + 45min pushes past 16:00)
    expect(slots[0].toISOString()).toBe(new Date(today.date.getTime() + 17 * 3600 * 1000).toISOString());
    expect(slots.every((s) => s.getTime() >= now.getTime() + 45 * 60 * 1000)).toBe(true);
  });
  it('today disappears from days when no slots remain (late night)', () => {
    const now = T('2026-10-12T18:00:00Z'); // 11:30 PM IST
    expect(availableDays(now)[0].label).not.toBe('Today');
  });
});

describe('isValidScheduledStart', () => {
  const now = T('2026-10-12T06:00:00Z'); // 11:30 AM IST
  it('accepts a valid afternoon slot', () => {
    expect(isValidScheduledStart(T('2026-10-12T10:30:00Z').toISOString(), now)).toBe(true); // 4 PM IST
  });
  it('rejects past and too-soon slots', () => {
    expect(isValidScheduledStart(T('2026-10-12T05:00:00Z').toISOString(), now)).toBe(false);
    expect(isValidScheduledStart(new Date(now.getTime() + 10 * 60 * 1000).toISOString(), now)).toBe(false);
  });
  it('rejects night starts and far-future starts', () => {
    expect(isValidScheduledStart(T('2026-10-12T20:00:00Z').toISOString(), now)).toBe(false); // 1:30 AM
    expect(isValidScheduledStart(T('2026-11-12T10:30:00Z').toISOString(), now)).toBe(false); // +31d
  });
  it('accepts a slot three weeks out (next month)', () => {
    expect(isValidScheduledStart(T('2026-11-02T10:30:00Z').toISOString(), now)).toBe(true); // +21d
  });
  it('rejects garbage', () => {
    expect(isValidScheduledStart(null, now)).toBe(false);
    expect(isValidScheduledStart('not-a-date', now)).toBe(false);
  });
});

describe('formatting + next opening', () => {
  const now = T('2026-10-12T06:00:00Z');
  it('labels today/tomorrow slots', () => {
    expect(formatSlot(T('2026-10-12T10:30:00Z').toISOString(), now)).toMatch(/^Today, /);
    expect(formatSlot(T('2026-10-13T10:30:00Z').toISOString(), now)).toMatch(/^Tomorrow, /);
  });
  it('slot chips show the time for days after tomorrow, not the date', () => {
    const label = formatSlotTime(T('2026-10-15T10:30:00Z').toISOString()); // Thu 4 PM IST
    expect(label).toMatch(/4:00/);
    expect(label).not.toMatch(/Oct/);
  });
  it('renders overnight windows like 4 PM – 4 AM', () => {
    const label = formatWindow(T('2026-10-12T10:30:00Z').toISOString(), 12);
    expect(label).toContain('4');
    expect(label).toContain('–');
  });
  it('formatWindow keeps the minutes for an off-the-hour ASAP start', () => {
    // 3:14 PM IST + 45 min = 3:59 PM — must not read as "3 pm – 6 pm".
    expect(formatWindow(T('2026-10-12T10:29:00Z').toISOString(), 3).replace(/\s/g, ' ').toLowerCase()).toBe(
      '3:59 pm – 6:59 pm'
    );
  });
  it('nextOpenStart points at 8 AM (same day before, next day after)', () => {
    expect(nextOpenStart(T('2026-10-12T20:00:00Z')).toISOString()).toBe('2026-10-13T02:30:00.000Z');
    expect(nextOpenStart(T('2026-10-12T06:00:00Z')).toISOString()).toBe('2026-10-13T02:30:00.000Z');
  });
});

describe('calendarMonths', () => {
  it('spans this month and next with 30 bookable days', () => {
    const now = T('2026-10-23T06:00:00Z'); // Fri 23 Oct, 11:30 AM IST
    const months = calendarMonths(now);
    expect(months.map((m) => m.label)).toEqual(['October 2026', 'November 2026']);
    const open = months.flatMap((m) => m.cells).filter((c) => c?.available);
    expect(open).toHaveLength(30);
    expect(open[0]?.day).toBe(23);
    expect(open[open.length - 1]?.day).toBe(21); // 21 Nov
  });
  it('pads the grid so the 1st lands on its weekday (Sunday first)', () => {
    const [oct] = calendarMonths(T('2026-10-23T06:00:00Z'));
    const lead = oct.cells.findIndex((c) => c !== null);
    expect(lead).toBe(4); // 1 Oct 2026 is a Thursday
  });
  it('day keys line up with availableDays and their slots', () => {
    const now = T('2026-10-23T06:00:00Z');
    const nov2 = calendarMonths(now)[1].cells.find((c) => c?.day === 2)!;
    expect(availableDays(now).some((d) => d.key === nov2.key)).toBe(true);
    expect(daySlots(nov2.date, now)).toHaveLength(16);
  });
});

describe('isDispatchable (rider pool gating, 60-min lead)', () => {
  const now = T('2026-10-12T06:00:00Z'); // 11:30 AM IST
  const iso = (utc: string) => T(utc).toISOString();
  it('shows ASAP and near-term runs', () => {
    expect(isDispatchable({ startAt: iso('2026-10-12T06:30:00Z') }, now)).toBe(true);
    expect(isDispatchable({ startAt: iso('2026-10-12T07:00:00Z') }, now)).toBe(true); // exactly 60 min
  });
  it('hides far-future scheduled runs', () => {
    expect(isDispatchable({ startAt: iso('2026-10-12T10:30:00Z') }, now)).toBe(false); // 4 PM slot
    expect(isDispatchable({ startAt: iso('2026-10-13T10:30:00Z') }, now)).toBe(false);
  });
  it('hides runs whose window already ended', () => {
    expect(
      isDispatchable({ startAt: iso('2026-10-12T00:00:00Z'), endAt: iso('2026-10-12T05:00:00Z') }, now)
    ).toBe(false);
  });
  it('keeps legacy orders without timestamps visible', () => {
    expect(isDispatchable({}, now)).toBe(true);
    expect(isDispatchable({ startAt: 'garbage' }, now)).toBe(true);
    expect(isDispatchable(null, now)).toBe(false);
  });
});

describe('rentalEndsInServiceHours (pickup must land 8 AM – 11:59 PM IST)', () => {
  const ist = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 31, h, m) - 5.5 * 3600 * 1000);
  it('lets a 3h rental start by 8 PM but not later', () => {
    expect(rentalEndsInServiceHours(ist(20), 3)).toBe(true); // 8 PM → 11 PM
    expect(rentalEndsInServiceHours(ist(21), 3)).toBe(false); // 9 PM → midnight
    expect(rentalEndsInServiceHours(ist(23), 3)).toBe(false); // 11 PM → 2 AM
  });
  it('lets an 11 PM start through on plans that end after 8 AM', () => {
    expect(rentalEndsInServiceHours(ist(23), 12)).toBe(true); // 11 PM → 11 AM
    expect(rentalEndsInServiceHours(ist(23), 24)).toBe(true); // 11 PM → 11 PM
    expect(rentalEndsInServiceHours(ist(23), 6)).toBe(false); // 11 PM → 5 AM
  });
  it('folds into isValidScheduledStart when hours are given', () => {
    const now = ist(10);
    expect(isValidScheduledStart(ist(23).toISOString(), now)).toBe(true);
    expect(isValidScheduledStart(ist(23).toISOString(), now, 3)).toBe(false);
    expect(isValidScheduledStart(ist(23).toISOString(), now, 12)).toBe(true);
  });
  it('turns ASAP off late in the evening for short plans', () => {
    expect(isAsapAvailable(ist(18), 3)).toBe(true); // 6:45 PM → 9:45 PM
    expect(isAsapAvailable(ist(22), 3)).toBe(false); // 10:45 PM → 1:45 AM
    expect(isAsapAvailable(ist(22), 12)).toBe(true); // → 10:45 AM
  });
});
