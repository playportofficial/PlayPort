import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { useNow } from '@/hooks/useNow';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { formatSlot, isServiceOpen, nextOpenStart } from '@/utils/serviceHours';

/**
 * Night mode (12–6 AM IST): we don't dispatch, but scheduling stays open.
 * Renders nothing during service hours.
 */
export function ServiceHoursBanner() {
  const tick = useNow(true);
  const now = new Date(tick);
  if (isServiceOpen(now)) return null;
  const opens = nextOpenStart(now);
  return (
    <View style={styles.banner}>
      <Ionicons name="moon-outline" size={18} color={colors.secondaryText} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>We’re resting 12–6 AM</Text>
        <Text style={styles.sub}>
          No late-night dropoffs — but you can schedule ahead from {formatSlot(opens.toISOString(), now)}.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  title: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  sub: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small, marginTop: 2, lineHeight: 17 },
});
