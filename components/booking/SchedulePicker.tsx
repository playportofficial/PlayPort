import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScheduleCalendar } from '@/components/booking/ScheduleCalendar';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useAppStore } from '@/store/appStore';
import {
  formatSlot,
  formatWindow,
  isAsapAvailable,
  isServiceOpen,
  isValidScheduledStart,
} from '@/utils/serviceHours';
import { formatLaunchDay } from '@/utils/launch';

interface Props {
  /** Longest rental window in the booking — drives the "ends at" preview. */
  maxHours: number;
  /** Pre-book launch: ASAP is off and no slot can start before this. */
  notBefore?: Date | null;
}

/**
 * Shared ASAP-vs-scheduled picker (product page + cart read/write the same
 * store slot, so both screens always agree).
 */
export function SchedulePicker({ maxHours, notBefore }: Props) {
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const setScheduledStartAt = useAppStore((s) => s.setScheduledStartAt);
  // Open on whatever is really saved — a slot picked earlier means Schedule, not ASAP.
  const [pickedMode, setSchedMode] = useState<'asap' | 'scheduled'>(() => (scheduledStartAt ? 'scheduled' : 'asap'));
  // A slot set from elsewhere (e.g. "Book … instead") must flip this to Schedule — never show ASAP over a saved slot.
  useEffect(() => {
    if (scheduledStartAt) setSchedMode('scheduled');
  }, [scheduledStartAt]);
  const now = useMemo(() => new Date(), []);
  const open = isServiceOpen(now);
  const asapOk = isAsapAvailable(now, maxHours, notBefore);
  const schedMode = asapOk ? pickedMode : 'scheduled';
  const scheduledValid = isValidScheduledStart(scheduledStartAt, new Date(), maxHours, notBefore);
  const beforeLaunch =
    Boolean(scheduledStartAt) &&
    isValidScheduledStart(scheduledStartAt, new Date()) &&
    !isValidScheduledStart(scheduledStartAt, new Date(), undefined, notBefore);
  const startTooLate =
    Boolean(scheduledStartAt) &&
    !beforeLaunch &&
    isValidScheduledStart(scheduledStartAt, new Date(), undefined, notBefore) &&
    !scheduledValid;

  return (
    <View style={styles.scheduleCard}>
      <Text style={styles.scheduleLabel}>DELIVERY TIME</Text>
      <View style={styles.modeRow}>
        <Pressable
          accessibilityRole="button"
          disabled={!asapOk}
          onPress={() => {
            setSchedMode('asap');
            setScheduledStartAt(null);
          }}
          style={[styles.modeChip, schedMode === 'asap' && styles.chipOn, !asapOk && styles.chipOff]}
        >
          <Ionicons
            name="flash"
            size={14}
            color={asapOk && schedMode === 'asap' ? colors.playportOrange : colors.secondaryText}
          />
          <Text style={[styles.chipText, schedMode === 'asap' && styles.chipTextOn]}>
            ASAP · ~45 min
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setSchedMode('scheduled')}
          style={[styles.modeChip, schedMode === 'scheduled' && styles.chipOn]}
        >
          <Ionicons
            name="calendar-outline"
            size={14}
            color={schedMode === 'scheduled' ? colors.playportOrange : colors.secondaryText}
          />
          <Text style={[styles.chipText, schedMode === 'scheduled' && styles.chipTextOn]}>
            Schedule
          </Text>
        </Pressable>
      </View>

      {notBefore ? (
        <Text style={styles.scheduleSub}>
          Pre-booking — rentals start from {formatLaunchDay(notBefore)}. Pick your day and time.
        </Text>
      ) : !open ? (
        <Text style={styles.scheduleSub}>Closed 12–8 AM — pick a slot from 8 AM onwards.</Text>
      ) : !asapOk ? (
        <Text style={styles.scheduleSub}>
          Too late for a {maxHours}h rental now — it would end after midnight. Schedule it, or pick a longer
          plan.
        </Text>
      ) : null}

      {schedMode === 'scheduled' ? (
        <>
          <ScheduleCalendar
            now={now}
            hours={maxHours}
            notBefore={notBefore}
            selectedIso={scheduledStartAt}
            onSelect={setScheduledStartAt}
          />
          {scheduledValid && scheduledStartAt ? (
            <Text style={styles.scheduleTime}>
              {formatSlot(scheduledStartAt, now)} · {formatWindow(scheduledStartAt, maxHours)} ({maxHours}h)
            </Text>
          ) : scheduledStartAt && !isValidScheduledStart(scheduledStartAt, new Date()) ? (
            <Text style={styles.scheduleWarn}>
              Your saved slot is too soon or has passed — pick a new time, or tap ASAP.
            </Text>
          ) : beforeLaunch && notBefore ? (
            <Text style={styles.scheduleWarn}>
              That’s before {formatLaunchDay(notBefore)} — pick a time from {formatLaunchDay(notBefore)} onwards.
            </Text>
          ) : startTooLate ? (
            <Text style={styles.scheduleWarn}>
              That start would end your {maxHours}h rental after midnight — pick an earlier time or a longer
              plan.
            </Text>
          ) : (
            <Text style={styles.scheduleSub}>
              Pick a day and time — your {maxHours}h starts when the kit is delivered.
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.scheduleSub}>
          {open
            ? `Arrives in about 45 min · your ${maxHours}h starts when the kit is delivered.`
            : 'ASAP resumes at 8 AM.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scheduleCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 12,
  },
  scheduleRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  scheduleLabel: { color: colors.mutedText, fontFamily: fonts.bodyMedium, fontSize: typeScale.caption, letterSpacing: 0.5 },
  scheduleTime: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.bodyLg, marginTop: 2 },
  scheduleSub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, marginTop: 2 },
  scheduleWarn: { color: colors.danger, fontFamily: fonts.bodyMedium, fontSize: typeScale.small, marginTop: 2 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    paddingVertical: 10,
  },
  chipOn: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  chipOff: { opacity: 0.5 },
  chipText: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: 13 },
  chipTextOn: { color: colors.primaryText },
});
