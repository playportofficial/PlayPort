import { Ionicons as IoniconsIcon } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import {
  asapWindowStart,
  checkSlot,
  findNextFreeSlot,
  windowLabel,
  type SlotCheckItem,
} from '@/lib/availability';
import { formatLaunchDay } from '@/utils/launch';
import { formatSlotTime, isAsapAvailable, isServiceOpen } from '@/utils/serviceHours';

interface Props {
  items: SlotCheckItem[];
  hubId?: string;
  /** Null = check the ASAP window. */
  startIso: string | null;
  /** Called with the suggested start when the user taps "book X–Y instead". */
  onApplySlot?: (startIso: string) => void;
  /** Pre-book launch: there is no ASAP window to check before this. */
  notBefore?: Date | null;
}

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; window: string }
  | { kind: 'soldout'; name: string; window: string; suggestionIso: string | null; suggestionWindow: string | null; hours: number }
  | { kind: 'nostock'; name: string }
  | { kind: 'closed' }
  | { kind: 'prebook' }
  | { kind: 'failed' };

/**
 * Orange "Check Availability" for ASAP or a scheduled window.
 * Simple verdict UI + next-free-slot suggestion when sold out.
 */
export function AvailabilityBlock({ items, hubId, startIso, onApplySlot, notBefore }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  // A verdict belongs to the exact window + items checked. Any change
  // (new slot, plan, quantity, cart edit) invalidates it back to idle.
  const contextKey = `${startIso ?? 'asap'}|${items
    .map((i) => `${i.productId}:${i.hours}:${i.quantity ?? 1}`)
    .join(',')}|${hubId ?? ''}`;
  useEffect(() => {
    setState({ kind: 'idle' });
  }, [contextKey]);

  const check = async () => {
    if (!items.length) return;
    const now = new Date();
    const startedAt = Date.now();
    const start = startIso ?? asapWindowStart(now);
    if (!startIso && notBefore) {
      setState({ kind: 'prebook' });
      return;
    }
    if (!startIso && !isAsapAvailable(now, Math.max(1, ...items.map((i) => i.hours)))) {
      setState({ kind: 'closed' });
      return;
    }
    setState({ kind: 'checking' });
    const finish = async (next: Exclude<State, { kind: 'idle' } | { kind: 'checking' }>) => {
      // Keep the verdict transition readable — never flash it for <700ms.
      const wait = 700 - (Date.now() - startedAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      setState(next);
    };
    const maxHours = Math.max(1, ...items.map((i) => i.hours));
    for (const item of items) {
      const { free, totalUnits, failed } = await checkSlot(item.productId, hubId, start, item.hours, item.quantity ?? 1);
      if (failed) {
        await finish({ kind: 'failed' });
        return;
      }
      if (totalUnits === 0) {
        await finish({ kind: 'nostock', name: item.name });
        return;
      }
      if (!free) {
        const suggestionIso = await findNextFreeSlot(
          item.productId,
          hubId,
          start,
          item.hours,
          item.quantity ?? 1,
          now
        );
        await finish({
          kind: 'soldout',
          name: item.name,
          window: windowLabel(start, maxHours),
          suggestionIso,
          suggestionWindow: suggestionIso ? windowLabel(suggestionIso, item.hours) : null,
          hours: item.hours,
        });
        return;
      }
    }
    await finish({
      kind: 'available',
      window: startIso
        ? `${windowLabel(start, maxHours)} · ready to book`
        : `Arrives ~${formatSlotTime(start)} · your ${maxHours}h starts on delivery`,
    });
  };

  return (
    <View style={styles.wrap}>
      <Button
        title="Check Availability"
        loading={state.kind === 'checking'}
        disabled={!items.length}
        icon={<IoniconsIcon name="calendar-outline" size={18} color={colors.white} />}
        onPress={() => void check()}
      />
      {state.kind === 'checking' ? (
        <Text style={styles.checkingText}>Checking live inventory…</Text>
      ) : null}

      {state.kind === 'available' ? (
        <View style={[styles.card, styles.okCard]}>
          <IoniconsIcon name="checkmark-circle" size={20} color={colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={styles.okTitle}>Slot available at this time.</Text>
            <Text style={styles.okSub}>{state.window}.</Text>
          </View>
        </View>
      ) : null}

      {state.kind === 'soldout' ? (
        <View style={[styles.card, styles.soldCard]}>
          <IoniconsIcon name="close-circle" size={20} color={colors.danger} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.soldTitle}>
              Currently the slot is sold out for {state.window}
              {items.length > 1 ? ` (${state.name})` : ''}.
            </Text>
            {state.suggestionIso && state.suggestionWindow ? (
              <>
                <Text style={styles.soldSub}>
                  You can book {state.suggestionWindow} — the slot is available then.
                </Text>
                {onApplySlot ? (
                  <View style={styles.applyRow}>
                    <Button
                      title={`Book ${state.suggestionWindow} instead`}
                      size="sm"
                      variant="secondary"
                      onPress={() => onApplySlot(state.suggestionIso as string)}
                    />
                  </View>
                ) : null}
              </>
            ) : (
              <Text style={styles.soldSub}>Try another day — everything nearby is booked.</Text>
            )}
          </View>
        </View>
      ) : null}

      {state.kind === 'nostock' ? (
        <View style={[styles.card, styles.soldCard]}>
          <IoniconsIcon name="cube-outline" size={20} color={colors.secondaryText} />
          <View style={{ flex: 1 }}>
            <Text style={styles.soldTitle}>
              No {state.name} kits in stock right now.
            </Text>
            <Text style={styles.soldSub}>
              We’re restocking this kit — check back soon or try another kit.
            </Text>
          </View>
        </View>
      ) : null}

      {state.kind === 'failed' ? (
        <View style={[styles.card, styles.soldCard]}>
          <IoniconsIcon name="cloud-offline-outline" size={20} color={colors.secondaryText} />
          <View style={{ flex: 1 }}>
            <Text style={styles.soldTitle}>Couldn’t check availability.</Text>
            <Text style={styles.soldSub}>Check your connection and tap Check Availability again.</Text>
          </View>
        </View>
      ) : null}

      {state.kind === 'prebook' && notBefore ? (
        <View style={[styles.card, styles.soldCard]}>
          <IoniconsIcon name="calendar-outline" size={20} color={colors.secondaryText} />
          <View style={{ flex: 1 }}>
            <Text style={styles.soldTitle}>Pick a time first.</Text>
            <Text style={styles.soldSub}>
              Rentals start from {formatLaunchDay(notBefore)} — choose a day and time above, then check.
            </Text>
          </View>
        </View>
      ) : null}

      {state.kind === 'closed' ? (
        <View style={[styles.card, styles.soldCard]}>
          <IoniconsIcon name="moon-outline" size={20} color={colors.secondaryText} />
          <View style={{ flex: 1 }}>
            <Text style={styles.soldTitle}>
              {isServiceOpen(new Date()) ? 'Too late for ASAP on this plan.' : 'We’re closed 12–8 AM.'}
            </Text>
            <Text style={styles.soldSub}>
              {isServiceOpen(new Date())
                ? 'It would end after midnight, when we can’t pick up. Schedule a slot or pick a longer plan.'
                : 'ASAP resumes at 8 AM — or schedule a slot ahead.'}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  checkingText: {
    color: colors.secondaryText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    textAlign: 'center',
  },
  card: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.md,
  },
  okCard: { backgroundColor: colors.successBg, borderColor: 'rgba(20,128,74,0.3)' },
  okTitle: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  okSub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, marginTop: 2 },
  soldCard: { backgroundColor: colors.dangerBg, borderColor: 'rgba(242,109,109,0.35)' },
  soldTitle: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body, lineHeight: 20 },
  soldSub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, lineHeight: 17 },
  applyRow: { marginTop: 8, alignSelf: 'flex-start' },
});
