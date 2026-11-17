import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ResponsiveGrid } from '@/components/layout/ResponsiveGrid';
import { AvailabilityBlock } from '@/components/booking/AvailabilityBlock';
import { SchedulePicker } from '@/components/booking/SchedulePicker';
import { useOrderNotBefore } from '@/hooks/useOrderNotBefore';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { StickyBottomBar, useStickyBarPadding } from '@/components/layout/StickyBottomBar';
import { ControllerAddonRow } from '@/components/products/ControllerAddonRow';
import { ProductCard } from '@/components/products/ProductCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ExpandableText } from '@/components/ui/ExpandableText';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { useCatalogStore } from '@/store/catalogStore';
import { useFeelStore } from '@/store/feelStore';
import { useExitToHomeOnBack } from '@/hooks/useExitToHomeOnBack';
import { gateCartAdd } from '@/utils/authGate';
import { formatINR } from '@/utils/format';
import { experienceImage } from '@/utils/images';
import { goHome } from '@/utils/navigation';
import { isValidScheduledStart } from '@/utils/serviceHours';
import { expandCheckItems } from '@/lib/availability';
import {
  addonsTotal,
  defaultExperiencePlan,
  describeControllerPrice,
  experienceAddonOptions,
  experiencePlans,
  priceForAddon,
} from '@/utils/rentalPricing';

export default function ExperienceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding, useSplitPane, productColumns, gap } = useResponsive();
  const stickyPad = useStickyBarPadding();
  const addExperienceToCart = useAppStore((s) => s.addExperienceToCart);
  const addProductToCart = useAppStore((s) => s.addProductToCart);
  const setScheduledStartAt = useAppStore((s) => s.setScheduledStartAt);
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const notBefore = useOrderNotBefore({ experienceId: id });
  const scheduledValid = isValidScheduledStart(scheduledStartAt, new Date(), undefined, notBefore);
  const experiences = useCatalogStore((s) => s.experiences);
  const products = useCatalogStore((s) => s.products);
  const hub = useCatalogStore((s) => s.hub);

  const experience = experiences.find((e) => e.id === id);
  const plans = experience ? experiencePlans(experience) : [];
  const [planId, setPlanId] = useState('');
  const [addonQty, setAddonQty] = useState<Record<string, number>>({});
  const showToast = useFeelStore((s) => s.showToast);
  const plan = plans.find((item) => item.id === planId) ?? (experience ? defaultExperiencePlan(experience) : null);
  const includedProducts = experience
    ? products.filter((p) => experience.productIds.includes(p.id))
    : [];
  const comboCheckItems = experience
    ? expandCheckItems(
        [
          {
            experienceId: experience.id,
            hours: plan?.hours ?? 12,
            quantity: 1,
            name: experience.name,
          },
        ],
        products,
        experiences
      )
    : [];
  // Combos rarely carry their own add-on pricing; the consoles inside them do, so an
  // extra controller stays orderable on every combo rather than only hand-priced ones.
  const controllerAddons = experienceAddonOptions(experience, products);
  const selectedAddons = Object.entries(addonQty)
    .filter(([, q]) => q > 0)
    .map(([addonId, quantity]) => ({ id: addonId, quantity }));
  const addonLines = controllerAddons
    .filter((a) => (addonQty[a.id] ?? 0) > 0)
    .map((a) => {
      const qty = Math.min(addonQty[a.id] ?? 0, a.maxQuantity);
      const total = priceForAddon(a, plan?.hours ?? 12, qty);
      return { id: a.id, name: a.name, quantity: qty, unitPrice: qty > 0 ? Math.round(total / qty) : 0 };
    });
  const extras = addonsTotal(addonLines);
  const bundleTotal = (plan?.price ?? experience?.price ?? 0) + extras;

  // Header + browser Back → home (not the previous browse page).
  useExitToHomeOnBack(true);

  if (!experience) {
    return (
      <Screen showHeader={false}>
        <ScreenHeader title="Combo" onBack={goHome} />
        <EmptyState
          title="Combo not found"
          subtitle="This bundle may have rotated out."
          actionLabel="Browse combos"
          onAction={goHome}
        />
      </Screen>
    );
  }

  const heroUri = experienceImage(experience, products);
  const heroBlock = (
    <View style={[styles.hero, useSplitPane && styles.heroSplit]}>
      {heroUri ? <Image source={{ uri: heroUri }} style={styles.heroImage} contentFit="contain" /> : null}
      <View style={styles.heroBadges}>
        <Badge label={experience.tag} />
        <Badge
          label={`${experience.etaMinutes} mins`}
          color={colors.secondaryText}
          left={<Ionicons name="time-outline" size={12} color={colors.secondaryText} />}
        />
      </View>
    </View>
  );

  const summaryBlock = (
    <View style={[styles.summary, useSplitPane && styles.summarySplit]}>
      <Text style={[styles.title, useSplitPane && styles.titleLg]}>{experience.name}</Text>
      {experience.description ? <ExpandableText text={experience.description} style={styles.desc} /> : null}
      <View style={styles.chips}>
        {experience.chips.map((chip) => (
          <Badge key={chip} label={chip} />
        ))}
      </View>
      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="people-outline" size={16} color={colors.playportOrange} />
          <Text style={styles.metaText}>{experience.people}</Text>
        </View>
        <Text style={styles.price}>
          {formatINR(plan?.price ?? experience.price)}
          <Text style={styles.duration}> {plan?.label ?? experience.durationLabel}</Text>
        </Text>
      </View>
    </View>
  );

  return (
    <Screen showHeader={false} edges={['top']} showFloatingCart>
      <ScreenHeader title="Combo" onBack={goHome} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: horizontalPadding, paddingBottom: stickyPad },
        ]}
      >
        <View style={[styles.topBlock, useSplitPane && styles.topBlockSplit]}>
          {heroBlock}
          {summaryBlock}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Choose a package</Text>
          <View style={styles.planRow}>
            {plans.map((item) => {
              const on = item.id === (plan?.id ?? '');
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setPlanId(item.id)}
                  style={[styles.planChip, on && styles.planChipOn]}
                >
                  <Text style={[styles.planLabel, on && styles.planLabelOn]}>{item.label}</Text>
                  <Text style={[styles.planPrice, on && styles.planLabelOn]}>{formatINR(item.price)}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {controllerAddons.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Extra controllers</Text>
            <Text style={styles.addonDesc}>
              {controllerAddons.length === 1
                ? `Add a second DualSense — ${describeControllerPrice(controllerAddons[0])}`
                : 'Each extra below uses this combo’s own price.'}
            </Text>
            {controllerAddons.map((addon) => (
              <ControllerAddonRow
                key={addon.id}
                addon={addon}
                hours={plan?.hours ?? 12}
                quantity={addonQty[addon.id] ?? 0}
                onIncrement={() =>
                  setAddonQty((prev) => ({
                    ...prev,
                    [addon.id]: Math.min(addon.maxQuantity, (prev[addon.id] ?? 0) + 1),
                  }))
                }
                onDecrement={() =>
                  setAddonQty((prev) => ({
                    ...prev,
                    [addon.id]: Math.max(0, (prev[addon.id] ?? 0) - 1),
                  }))
                }
              />
            ))}
          </View>
        ) : null}

        <SchedulePicker maxHours={plan?.hours ?? 12} notBefore={notBefore} />

        {comboCheckItems.length ? (
          <AvailabilityBlock
            items={comboCheckItems}
            hubId={hub?.id}
            notBefore={notBefore}
            startIso={
              scheduledValid && isValidScheduledStart(scheduledStartAt, new Date(), plan?.hours ?? 12, notBefore)
                ? (scheduledStartAt as string)
                : null
            }
            onApplySlot={(iso) => {
              setScheduledStartAt(iso);
              showToast('Slot set — book the combo to lock it in');
            }}
          />
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What&apos;s included</Text>
          <View style={styles.includes}>
            {experience.includes.map((item) => (
              <View key={item} style={styles.includeRow}>
                <Ionicons name="checkmark-circle" size={16} color={colors.secondaryText} />
                <Text style={styles.includeText}>{item}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          <View style={styles.howList}>
            {experience.howItWorks.map((step, index) => (
              <View key={step} style={styles.howRow}>
                <View style={styles.howNum}>
                  <Text style={styles.howNumText}>{index + 1}</Text>
                </View>
                <Text style={styles.howText}>{step}</Text>
              </View>
            ))}
          </View>
        </View>

        {includedProducts.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Included products</Text>
            <ResponsiveGrid columns={productColumns} gap={gap}>
              {includedProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  compact={productColumns === 1}
                  onPress={() => router.push(`/product/${product.id}`)}
                  onAdd={(selection) => {
                    const options = {
                      planId: selection.planId,
                      inventoryUnitId: selection.inventoryUnitId,
                    };
                    if (!gateCartAdd('/cart', { kind: 'product', productId: product.id, options })) return;
                    addProductToCart(product.id, options);
                    router.push('/cart');
                  }}
                />
              ))}
            </ResponsiveGrid>
          </View>
        ) : null}
      </ScrollView>

      <StickyBottomBar>
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={styles.stickyLabel}>
            Bundle total{extras > 0 ? ` · incl. ${formatINR(extras)} extras` : ''}
          </Text>
          <Text style={styles.stickyPrice}>{formatINR(bundleTotal)}</Text>
        </View>
        <Button
          title="Add to cart"
          icon={<Ionicons name="bag-add-outline" size={16} color={colors.white} />}
          onPress={() => {
            const chosen = plan?.id;
            if (
              !gateCartAdd('/cart', {
                kind: 'experience',
                experienceId: experience.id,
                planId: chosen,
                addons: selectedAddons,
              })
            )
              return;
            addExperienceToCart(experience.id, chosen, selectedAddons);
            showToast(selectedAddons.length ? 'Combo + extras added' : 'Combo added');
          }}
          style={styles.bookBtn}
        />
      </StickyBottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: spacing.lg, paddingTop: spacing.sm },
  planRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  planChip: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 96,
  },
  planChipOn: { borderColor: colors.playportOrange, backgroundColor: colors.orangeTint },
  planLabel: { color: colors.secondaryText, fontFamily: fonts.bodyMedium, fontSize: 13 },
  planLabelOn: { color: colors.primaryText },
  planPrice: { color: colors.primaryText, fontFamily: fonts.headingMedium, fontSize: 15, marginTop: 2 },
  topBlock: { gap: spacing.lg },
  topBlockSplit: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    gap: spacing.xl,
  },
  hero: {
    borderRadius: radii.xl,
    overflow: 'hidden',
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: 380,
    backgroundColor: colors.white,
  },
  heroSplit: {
    flex: 1,
    width: undefined,
    height: undefined,
    minHeight: 260,
    maxWidth: 560,
    aspectRatio: 4 / 3,
  },
  heroImage: { ...StyleSheet.absoluteFill },
  heroBadges: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  summary: { gap: spacing.md },
  summarySplit: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 280,
  },
  title: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 22, lineHeight: 28 },
  titleLg: { fontSize: 28, lineHeight: 34 },
  desc: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13 },
  price: { color: colors.primaryText, fontFamily: fonts.monoMedium, fontSize: 20 },
  duration: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13 },
  section: { gap: spacing.md },
  sectionTitle: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: 17 },
  includes: { gap: 10 },
  includeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  includeText: { color: colors.primaryText, fontFamily: fonts.body, fontSize: 14, flex: 1 },
  howList: { gap: 12 },
  howRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  howNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  howNumText: { color: colors.playportOrange, fontFamily: fonts.monoMedium, fontSize: 12 },
  howText: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 13, lineHeight: 19, flex: 1 },
  stickyLabel: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: 12 },
  stickyPrice: { color: colors.primaryText, fontFamily: fonts.monoMedium, fontSize: 18, marginTop: 2 },
  bookBtn: { minWidth: 160 },
  addonDesc: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: 13,
    marginTop: -8,
    lineHeight: 18,
  },
});
