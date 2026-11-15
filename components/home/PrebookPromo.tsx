import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radii, shadows, spacing, typeScale, webShadows } from '@/constants/theme';
import type { Product } from '@/types';

/** First day GTA 6 rentals can be booked. */
const DROP_DATE = '19 Nov';

interface Props {
  /** The GTA 6 product, when ops have listed it — its photo becomes the card art. */
  product?: Product;
  onPress?: () => void;
}

/**
 * Pre-book teaser that sits beside the console cards on the home grid. Rentals are
 * data-driven, so this stays a promo: it shows the drop date and, once the GTA 6
 * product exists in the catalog, uses its photo and opens its page.
 */
export function PrebookPromo({ product, onPress }: Props) {
  const photo = product?.images?.[0];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Pre-book GTA 6 from ${DROP_DATE}`}
      onPress={onPress}
      style={({ pressed }) => [styles.wrap, pressed && styles.pressed]}
    >
      {photo ? (
        <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <LinearGradient
          colors={['#2A0A4A', '#B9185B', '#FF7A18']}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {photo ? (
        <LinearGradient
          colors={['rgba(12,4,24,0.15)', 'rgba(12,4,24,0.82)']}
          start={{ x: 0.5, y: 0.1 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      <View style={styles.content}>
        <View style={styles.pill}>
          <Ionicons name="calendar-outline" size={12} color={colors.white} />
          <Text style={styles.pillText}>Pre-book from {DROP_DATE}</Text>
        </View>

        <View style={styles.bottom}>
          <Text style={styles.kicker}>Grand Theft Auto</Text>
          <Text style={styles.title}>GTA 6</Text>
          <Text style={styles.sub}>
            In our lineup from {DROP_DATE} — lock your console bundle before the drop.
          </Text>
          <View style={styles.cta}>
            <Text style={styles.ctaText}>Pre-book now</Text>
            <Ionicons name="arrow-forward" size={14} color={colors.white} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 260,
    borderRadius: radii.xl,
    overflow: 'hidden',
    backgroundColor: '#2A0A4A',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...shadows.card,
    ...Platform.select({
      web: { boxShadow: webShadows.card } as object,
      default: {},
    }),
  },
  pressed: { opacity: 0.94 },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    padding: spacing.lg,
    gap: spacing.md,
  },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radii.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  pillText: {
    color: colors.white,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.2,
  },
  bottom: { gap: 4 },
  kicker: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.white,
    fontFamily: fonts.heading,
    fontSize: 52,
    lineHeight: 56,
    letterSpacing: -1.5,
  },
  sub: {
    color: 'rgba(255,255,255,0.88)',
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    lineHeight: 18,
    maxWidth: 260,
  },
  cta: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radii.full,
    backgroundColor: colors.playportOrange,
    ...shadows.glow,
  },
  ctaText: {
    color: colors.white,
    fontFamily: fonts.heading,
    fontSize: typeScale.body,
    letterSpacing: 0.2,
  },
});
