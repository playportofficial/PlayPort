import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ResponsiveGrid } from '@/components/layout/ResponsiveGrid';
import { Screen } from '@/components/layout/Screen';
import { EnterUp } from '@/components/motion/Enter';
import { PlayPortWordmark } from '@/components/brand/PlayPortWordmark';
import { ExperienceCard } from '@/components/products/ExperienceCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { COMBOS_ENABLED } from '@/constants/features';
import { colors, fonts, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useCatalogStore } from '@/store/catalogStore';

export default function CombosScreen() {
  const { horizontalPadding, experienceColumns, gap } = useResponsive();
  const experiences = useCatalogStore((s) => s.experiences);
  const ready = useCatalogStore((s) => s.ready);
  const hydrate = useCatalogStore((s) => s.hydrate);
  const cols = Math.max(1, experienceColumns);

  if (!COMBOS_ENABLED) {
    return (
      <Screen showHeader={false} showCart={false} showDelivery={false}>
        <View style={styles.paused}>
          <PlayPortWordmark size={40} />
          <Text style={styles.pausedTitle}>Combos are paused</Text>
          <Text style={styles.pausedBody}>We’re updating bundles — book kits from Home for now.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen showFloatingCart pageTitle="Combos" showCart={false} showDelivery={false}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: horizontalPadding, paddingBottom: spacing.huge + 120 },
        ]}
      >
        {experiences.length ? (
          <ResponsiveGrid columns={cols} gap={gap}>
            {experiences.map((experience, index) => (
              <EnterUp key={experience.id} index={index} style={{ width: '100%' }}>
                <ExperienceCard
                  experience={experience}
                  onPress={() => router.push(`/experience/${experience.id}`)}
                  // Open the combo page so Extra Controller can be chosen before cart —
                  // Quick Book used to skip that and left combos without controller extras.
                  onBook={() => router.push(`/experience/${experience.id}`)}
                />
              </EnterUp>
            ))}
          </ResponsiveGrid>
        ) : (
          <EmptyState
            icon="layers-outline"
            title={ready ? 'No combos yet' : 'Loading combos…'}
            subtitle={
              ready
                ? 'Combos will appear here once ops publish them in Admin.'
                : 'Fetching the latest bundles from your hub.'
            }
            actionLabel={ready ? 'Retry' : undefined}
            onAction={ready ? () => void hydrate() : undefined}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: spacing.xl, paddingTop: spacing.lg, backgroundColor: colors.surfaceAlt, flexGrow: 1 },
  paused: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.sm,
    backgroundColor: colors.page,
  },
  pausedTitle: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 36,
    letterSpacing: -1,
    textAlign: 'center',
  },
  pausedBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.title,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 340,
  },
});
