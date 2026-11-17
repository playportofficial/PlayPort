import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { useCatalogStore } from '@/store/catalogStore';
import { formatINR } from '@/utils/format';
import { experienceImage } from '@/utils/images';
import { defaultExperiencePlan, experiencePlans } from '@/utils/rentalPricing';
import type { Experience } from '@/types';

interface Props {
  experience: Experience;
  onPress?: () => void;
  onBook?: (planId: string) => void;
}

export function ExperienceCard({ experience, onPress, onBook }: Props) {
  const products = useCatalogStore((s) => s.products);
  const plans = experiencePlans(experience);
  const [planId, setPlanId] = useState(defaultExperiencePlan(experience).id);
  const plan = plans.find((item) => item.id === planId) ?? defaultExperiencePlan(experience);
  const imageUri = experienceImage(experience, products);
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={experience.name} onPress={onPress}>
        <View style={styles.imageWrap}>
          {imageUri ? <Image source={{ uri: imageUri }} style={styles.image} contentFit="contain" /> : null}
          <View style={styles.topRow}>
            <Badge label={experience.tag} />
            <Badge
              label={`${experience.etaMinutes} mins`}
              color={colors.secondaryText}
              left={<Ionicons name="time-outline" size={12} color={colors.secondaryText} />}
            />
          </View>
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={2}>
            {experience.name}
          </Text>
          <Text style={styles.desc} numberOfLines={2}>
            {experience.description}
          </Text>
          <View style={styles.chips}>
            {experience.chips.slice(0, 3).map((chip) => (
              <Badge key={chip} label={chip} />
            ))}
          </View>
        </View>
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.planRow}>
        {plans.map((item) => {
          const on = item.id === plan.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setPlanId(item.id)}
              style={[styles.planChip, on && styles.planChipOn]}
            >
              <Text style={[styles.planText, on && styles.planTextOn]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.price}>
          {formatINR(plan.price)} <Text style={styles.duration}>{plan.label}</Text>
        </Text>
        <Button
          title="Book with extras"
          size="sm"
          onPress={() => (onBook ? onBook(plan.id) : onPress?.())}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  imageWrap: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.white },
  image: { ...StyleSheet.absoluteFill },
  topRow: {
    position: 'absolute',
    zIndex: 2,
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md, gap: 8 },
  title: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 19 },
  desc: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  planRow: { gap: 6, paddingHorizontal: spacing.lg },
  planChip: {
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  planChipOn: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  planText: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: 12 },
  planTextOn: { color: colors.primaryText },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  price: { color: colors.primaryText, fontFamily: fonts.monoMedium, fontSize: 18, flexShrink: 1 },
  duration: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13 },
});
