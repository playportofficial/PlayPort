import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ResponsiveGrid } from '@/components/layout/ResponsiveGrid';
import { AvailabilityBlock } from '@/components/booking/AvailabilityBlock';
import { SchedulePicker } from '@/components/booking/SchedulePicker';
import { Screen } from '@/components/layout/Screen';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { StickyBottomBar, useStickyBarPadding } from '@/components/layout/StickyBottomBar';
import { ControllerAddonRow } from '@/components/products/ControllerAddonRow';
import { DurationSelector } from '@/components/products/DurationSelector';
import { ProductCard } from '@/components/products/ProductCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ExpandableText } from '@/components/ui/ExpandableText';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { colors, fonts, radii, shadows, spacing, typeScale } from '@/constants/theme';
import { useOrderNotBefore } from '@/hooks/useOrderNotBefore';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { useCatalogStore } from '@/store/catalogStore';
import { useFeelStore } from '@/store/feelStore';
import { gateCartAdd } from '@/utils/authGate';
import { formatINR } from '@/utils/format';
import { isValidScheduledStart } from '@/utils/serviceHours';
import { firstDisplayableImage } from '@/utils/images';
import { formatLaunchDay, unitBookableFor, upcomingLaunch } from '@/utils/launch';
import { productForStart, upcomingPriceChange } from '@/utils/priceChange';
import {
  addonsTotal,
  computeAddonLines,
  defaultPlan,
  describeControllerPrice,
  isControllerAddon,
  kitUnitPrice,
  normalizeProduct,
  priceForAddon,
  resolveHours,
} from '@/utils/rentalPricing';
import type { PricingMode } from '@/types';

const FLOW_STEPS = [
  {
    title: 'Prepared at the hub',
    body: 'The kit is checked before a rider leaves with it.',
  },
  {
    title: 'Delivered to you',
    body: 'You can follow a live arrival time once the rider is on the way.',
  },
  {
    title: 'Set up, then collected',
    body: 'The rider sets the kit up and picks it up when your slot ends.',
  },
];

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { horizontalPadding, useSplitPane, productColumns, gap } = useResponsive();
  const stickyPad = useStickyBarPadding();
  const reviews = useAppStore((s) => s.reviews);
  const cart = useAppStore((s) => s.cart);
  const addProductToCart = useAppStore((s) => s.addProductToCart);
  const updateCartQuantity = useAppStore((s) => s.updateCartQuantity);
  const products = useCatalogStore((s) => s.products);
  const units = useCatalogStore((s) => s.units);
  const hub = useCatalogStore((s) => s.hub);
  const setScheduledStartAt = useAppStore((s) => s.setScheduledStartAt);
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const notBefore = useOrderNotBefore({ productId: id });
  const scheduledValid = isValidScheduledStart(scheduledStartAt, new Date(), undefined, notBefore);
  const showToast = useFeelStore((s) => s.showToast);

  const product = products.find((p) => p.id === id);
  const priceStart = scheduledValid ? scheduledStartAt : null;
  const normalized = product ? normalizeProduct(productForStart(product, priceStart)) : null;
  const priceChangeOn = product ? upcomingPriceChange(product) : null;
  const priceChangeApplies = Boolean(priceChangeOn && priceStart && new Date(priceStart) >= priceChangeOn);
  const initialPlan = product ? defaultPlan(product) : null;

  const [mode, setMode] = useState<PricingMode>('package');
  const [planId, setPlanId] = useState(initialPlan?.id ?? '12h');
  const [hourlyHours, setHourlyHours] = useState(1);
  const [addonQty, setAddonQty] = useState<Record<string, number>>({});
  const [unitId, setUnitId] = useState<string | null>(null);
  const [heroFailed, setHeroFailed] = useState(false);

  useEffect(() => {
    if (!product) return;
    const plan = defaultPlan(product);
    setPlanId(plan?.id ?? product.plans?.[0]?.id ?? '12h');
    setMode('package');
    setHourlyHours(1);
    setAddonQty({});
    setUnitId(null);
    setHeroFailed(false);
  }, [product?.id]);

  const productReviews = useMemo(
    () => reviews.filter((r) => r.productId === product?.id && !r.hidden),
    [reviews, product?.id]
  );
  const related = useMemo(
    () => products.filter((p) => p.id !== product?.id && p.id !== 'screen-addon').slice(0, 4),
    [product?.id, products]
  );

  const qtyFor = (productId: string) =>
    cart.filter((c) => c.productId === productId).reduce((sum, c) => sum + c.quantity, 0);
  const cartItemIdFor = (productId: string) => cart.find((c) => c.productId === productId)?.id;

  if (!product || !normalized) {
    return (
      <Screen showHeader={false}>
        <ScreenHeader title="Item Detail" onBack={() => router.replace('/(tabs)' as never)} />
        <EmptyState
          title="Product not found"
          subtitle="This kit may have moved hubs."
          actionLabel="Explore"
          onAction={() => router.replace('/(tabs)')}
        />
      </Screen>
    );
  }

  const productUnits = units.filter((u) => u.productId === product?.id && unitBookableFor(u, priceStart));
  // Unit choice only matters when units actually differ (installed games).
  // Otherwise the system auto-assigns a free kit — no picker noise.
  const unitsHaveGames = productUnits.some((u) => (u.games ?? []).length > 0);
  const controllerAddons = (normalized?.addons ?? []).filter((a) => isControllerAddon(a));
  const otherAddons = (normalized?.addons ?? []).filter((a) => !isControllerAddon(a));
  const hours = resolveHours(normalized, mode, planId, hourlyHours);
  const kitPrice = kitUnitPrice(normalized, mode, planId, hours);
  const selectedAddons = Object.entries(addonQty)
    .filter(([, q]) => q > 0)
    .map(([addonId, quantity]) => ({ id: addonId, quantity }));
  const addonLines = computeAddonLines(normalized, hours, selectedAddons);
  const extras = addonsTotal(addonLines);
  const lineTotal = kitPrice + extras;
  const durationLabel =
    mode === 'hourly'
      ? `${hours}h hourly`
      : normalized.plans.find((p) => p.id === planId)?.label ?? planId;

  const launch = upcomingLaunch(product);
  const heroUri = firstDisplayableImage(product.images);
  const showHero = Boolean(heroUri) && !heroFailed;
  const heroBlock = showHero && heroUri ? (
    <View style={[styles.hero, useSplitPane && styles.heroSplit]}>
      <Image
        source={{ uri: heroUri }}
        style={styles.heroImage}
        contentFit="cover"
        onError={() => setHeroFailed(true)}
      />
      <View style={styles.heroTop}>
        <Badge
          label={`DELIVERED IN ${product.etaMinutes} MINS`}
          color={colors.etaText}
          backgroundColor={colors.etaBg}
          left={<Ionicons name="flash" size={12} color={colors.etaText} />}
        />
      </View>
      <View style={styles.heroBottom}>
        <View style={styles.sanitizePill}>
          <Ionicons name="checkmark-circle" size={14} color={colors.success} />
          <Text style={styles.sanitizeText}>{product.badge ?? 'Sanitized Pro Kit'}</Text>
          <Text style={styles.ratingText}>
            ★ {product.rating} ({product.reviewCount}+)
          </Text>
        </View>
      </View>
    </View>
  ) : null;

  const summaryBlock = (
    <View style={[styles.summary, showHero && useSplitPane && styles.summarySplit]}>
      {!showHero ? (
        <View style={styles.tagRow}>
          <Badge
            label={`Delivered in ${product.etaMinutes} mins`}
            color={colors.etaText}
            backgroundColor={colors.etaBg}
            left={<Ionicons name="flash" size={12} color={colors.etaText} />}
          />
          <Text style={styles.ratingInline}>
            ★ {product.rating} ({product.reviewCount}+)
          </Text>
        </View>
      ) : null}
      <View style={styles.tagRow}>
        {product.tags.map((tag) => (
          <Badge
            key={tag}
            label={tag}
            color={
              tag.toLowerCase().includes('gaming') || tag.toLowerCase().includes('drop')
                ? colors.white
                : colors.secondaryText
            }
            backgroundColor={
              tag.toLowerCase().includes('gaming') || tag.toLowerCase().includes('drop')
                ? colors.playportOrange
                : colors.surfaceAlt
            }
          />
        ))}
      </View>
      <Text style={[styles.title, useSplitPane && styles.titleLg]}>{product.name}</Text>
      {launch ? (
        <View style={styles.launchNote}>
          <Ionicons name="rocket-outline" size={16} color={colors.playportOrange} />
          <Text style={styles.launchText}>
            Pre-book now · rentals start from {formatLaunchDay(launch)}
          </Text>
        </View>
      ) : null}
      {priceChangeOn ? (
        <View style={styles.launchNote}>
          <Ionicons name="pricetag-outline" size={16} color={colors.playportOrange} />
          <Text style={styles.launchText}>
            {priceChangeApplies
              ? `Showing prices for rentals from ${formatLaunchDay(priceChangeOn)}`
              : `New prices from ${formatLaunchDay(priceChangeOn)} — schedule a slot from then to see them`}
          </Text>
        </View>
      ) : null}
      {product.description ? <ExpandableText text={product.description} style={styles.desc} /> : null}
      <View style={styles.pricePreview}>
        <Text style={styles.pricePreviewLabel}>Selected</Text>
        <Text style={styles.pricePreviewValue}>
          {formatINR(lineTotal)} / {durationLabel}
        </Text>
      </View>
    </View>
  );

  return (
    <Screen showHeader={false} edges={['top']}>
      <ScreenHeader title="Item Detail" onBack={() => router.replace('/(tabs)' as never)} />
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: horizontalPadding, paddingBottom: stickyPad },
        ]}
      >
        <View style={[styles.topBlock, showHero && useSplitPane && styles.topBlockSplit]}>
          {heroBlock}
          {summaryBlock}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionTop}>
            <SectionHeader eyebrow="Duration" title="Select rental plan" />
            <Text style={styles.metaLabel}>FREE SETUP</Text>
          </View>
          <DurationSelector
            product={normalized}
            mode={mode}
            planId={planId}
            hourlyHours={hourlyHours}
            onModeChange={setMode}
            onPlanChange={setPlanId}
            onHourlyHoursChange={setHourlyHours}
          />
          <SchedulePicker maxHours={hours} notBefore={notBefore} />
          <AvailabilityBlock
            items={[{ productId: product.id, hours, name: product.shortName }]}
            hubId={hub?.id}
            notBefore={notBefore}
            startIso={
              scheduledValid && isValidScheduledStart(scheduledStartAt, new Date(), hours, notBefore)
                ? (scheduledStartAt as string)
                : null
            }
            onApplySlot={(iso) => {
              setScheduledStartAt(iso);
              showToast('Slot set — add to cart to book it');
            }}
          />
        </View>

        {unitsHaveGames ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Your console" title="Choose which one" />
            <Text style={styles.addonDesc}>
              Each console is a different set. The games on it are not the same as the next one. Tap Games to see that set.
            </Text>
            {productUnits.map((unit) => {
              const selected = unitId === unit.id;
              const games = unit.games ?? [];
              return (
                <Pressable
                  key={unit.id}
                  onPress={() => setUnitId(unit.id)}
                  style={[styles.addonRow, selected && styles.unitSelected]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.addonName}>{unit.skuLabel}</Text>
                    <Text style={styles.addonDesc} numberOfLines={1}>
                      {games.length
                        ? `${games.slice(0, 3).join(' · ')}${games.length > 3 ? ` +${games.length - 3} more` : ''}`
                        : 'Games not listed yet'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`View games on ${unit.skuLabel}`}
                    onPress={() => router.push(`/unit-games/${unit.id}` as never)}
                    hitSlop={6}
                    style={styles.gamesLink}
                  >
                    <Ionicons name="game-controller-outline" size={13} color={colors.playportOrange} />
                    <Text style={styles.gamesLinkText}>Games</Text>
                  </Pressable>
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={selected ? colors.playportOrange : colors.mutedText}
                  />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {controllerAddons.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Extras" title="Extra controllers" />
            <Text style={styles.addonDesc}>
              {controllerAddons.length === 1
                ? `This kit: ${describeControllerPrice(controllerAddons[0])}`
                : 'Each extra below uses this kit’s own price.'}
            </Text>
            {controllerAddons.map((addon) => (
              <ControllerAddonRow
                key={addon.id}
                addon={addon}
                hours={hours}
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

        {otherAddons.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Add-ons" title="Optional extras" />
            {otherAddons.map((addon) => {
              const qty = addonQty[addon.id] ?? 0;
              const unitPreview = priceForAddon(addon, hours, 1);
              return (
                <View key={addon.id} style={styles.addonRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.addonName}>{addon.name}</Text>
                    {addon.description ? (
                      <Text style={styles.addonDesc}>{addon.description}</Text>
                    ) : null}
                    <Text style={styles.addonPrice}>{formatINR(unitPreview)} each</Text>
                  </View>
                  <View style={styles.stepper}>
                    <Pressable
                      onPress={() =>
                        setAddonQty((prev) => ({
                          ...prev,
                          [addon.id]: Math.max(0, (prev[addon.id] ?? 0) - 1),
                        }))
                      }
                      style={styles.stepBtn}
                    >
                      <Ionicons name="remove" size={16} color={colors.primaryText} />
                    </Pressable>
                    <Text style={styles.stepValue}>{qty}</Text>
                    <Pressable
                      onPress={() =>
                        setAddonQty((prev) => ({
                          ...prev,
                          [addon.id]: Math.min(addon.maxQuantity, (prev[addon.id] ?? 0) + 1),
                        }))
                      }
                      style={styles.stepBtn}
                    >
                      <Ionicons name="add" size={16} color={colors.primaryText} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {product.includes.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionTop}>
            <SectionHeader eyebrow="Includes" title="What's in the transit case" />
            <Text style={styles.metaLabel}>{product.includes.length} items</Text>
          </View>
          <View style={styles.includesList}>
            {product.includes.map((item) => (
              <View key={item.title} style={styles.includeRow}>
                <View style={styles.includeIcon}>
                  <Ionicons name="cube-outline" size={16} color={colors.secondaryText} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.includeTitleRow}>
                    <Text style={styles.includeTitle}>{item.title}</Text>
                    {item.tag ? <Badge label={item.tag} /> : null}
                  </View>
                  <Text style={styles.includeDetail}>{item.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow="Promise" title="Instant flow guarantee" />
          <View style={styles.flowList}>
            {FLOW_STEPS.map((step, index) => (
              <View key={step.title} style={styles.flowRow}>
                <View style={styles.flowNum}>
                  <Text style={styles.flowNumText}>{String(index + 1).padStart(2, '0')}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.flowTitle}>{step.title}</Text>
                  <Text style={styles.flowBody}>{step.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {productReviews.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.sectionTop}>
            <SectionHeader eyebrow="Reviews" title="Customer reviews" />
            <Text style={styles.metaLabel}>{product.rating.toFixed(1)} / 5</Text>
          </View>
          {productReviews.map((review) => (
            <View key={review.id} style={styles.reviewCard}>
              <View style={styles.reviewHeader}>
                <Text style={styles.reviewer}>{review.userName}</Text>
                <Text style={styles.reviewDate}>{review.dateLabel}</Text>
              </View>
              <Text style={styles.reviewStars}>{'★'.repeat(review.rating)}</Text>
              <Text style={styles.reviewText}>{review.text}</Text>
            </View>
          ))}
        </View>
        ) : null}

        {related.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="More like this" title="Other kits" />
            <ResponsiveGrid columns={productColumns} gap={gap}>
              {related.map((item) => (
                <ProductCard
                  key={item.id}
                  product={item}
                  compact={productColumns === 1}
                  quantityInCart={qtyFor(item.id)}
                  onPress={() => router.push(`/product/${item.id}`)}
                  onAdd={(selection) => {
                    const options = {
                      planId: selection.planId,
                      inventoryUnitId: selection.inventoryUnitId,
                    };
                    if (
                      !gateCartAdd(`/product/${item.id}`, {
                        kind: 'product',
                        productId: item.id,
                        options,
                      })
                    )
                      return;
                    addProductToCart(item.id, options);
                  }}
                  onIncrement={(selection) => {
                    const options = {
                      planId: selection.planId,
                      inventoryUnitId: selection.inventoryUnitId,
                    };
                    if (
                      !gateCartAdd(`/product/${item.id}`, {
                        kind: 'product',
                        productId: item.id,
                        options,
                      })
                    )
                      return;
                    addProductToCart(item.id, options);
                  }}
                  onDecrement={() => {
                    const cartId = cartItemIdFor(item.id);
                    const qty = qtyFor(item.id);
                    if (cartId) updateCartQuantity(cartId, qty - 1);
                  }}
                />
              ))}
            </ResponsiveGrid>
          </View>
        ) : null}
      </ScrollView>

      <StickyBottomBar>
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={styles.selectedLabel}>
            Kit {formatINR(kitPrice)}
            {extras > 0 ? ` + add-ons ${formatINR(extras)}` : ''}
          </Text>
          <Text style={styles.selectedPrice}>
            {formatINR(lineTotal)} · {durationLabel}
          </Text>
        </View>
        <Button
          title={launch ? 'Pre-book' : 'Add to cart'}
          icon={<Ionicons name="bag-add-outline" size={16} color={colors.white} />}
          onPress={() => {
            if (unitsHaveGames && !unitId) {
              showToast('Choose which unit you want');
              return;
            }
            const unit = productUnits.find((u) => u.id === unitId);
            const options = {
              planId: mode === 'hourly' ? 'hourly' : planId,
              pricingMode: mode,
              hours,
              addons: selectedAddons,
              inventoryUnitId: unit?.id,
              unitLabel: unit
                ? `${unit.skuLabel}${(unit.games ?? []).length ? ` · ${unit.games!.join(', ')}` : ''}`
                : undefined,
            };
            if (!gateCartAdd('/cart', { kind: 'product', productId: product.id, options })) return;
            addProductToCart(product.id, options);
            router.push('/cart');
          }}
          style={styles.bookBtn}
        />
      </StickyBottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  launchNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: colors.orangeTint,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  launchText: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.small },
  scrollView: { flex: 1 },
  scroll: { gap: spacing.xl, paddingTop: spacing.sm },
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
    aspectRatio: 1,
    backgroundColor: colors.surfaceAlt,
    ...shadows.soft,
  },
  heroSplit: {
    flex: 1,
    width: undefined,
    aspectRatio: 1,
    minHeight: 280,
    maxHeight: 520,
    maxWidth: 520,
  },
  heroImage: { ...StyleSheet.absoluteFill },
  heroTop: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  heroBottom: { position: 'absolute', left: 14, right: 14, bottom: 14 },
  sanitizePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  sanitizeText: { color: colors.white, fontFamily: fonts.bodyMedium, fontSize: typeScale.small },
  ratingText: { color: 'rgba(255,255,255,0.86)', fontFamily: fonts.bodyMedium, fontSize: typeScale.caption },
  summary: { gap: spacing.md },
  summarySplit: {
    flex: 1,
    justifyContent: 'flex-start',
    minWidth: 280,
    paddingTop: spacing.sm,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  ratingInline: {
    color: colors.secondaryText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
  },
  title: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  titleLg: { fontSize: typeScale.display, lineHeight: 34 },
  desc: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 21,
  },
  pricePreview: { gap: 4, marginTop: spacing.sm },
  pricePreviewLabel: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  pricePreviewValue: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.headline,
  },
  section: { gap: spacing.md },
  sectionTop: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 12,
  },
  metaLabel: {
    color: colors.mutedText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
    flexShrink: 0,
  },
  addonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
  },
  unitSelected: {
    borderColor: colors.playportOrange,
    backgroundColor: colors.orangeTint,
  },
  gamesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.orangeBorder,
    backgroundColor: colors.orangeTint,
    borderRadius: radii.full,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  gamesLinkText: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
  },
  addonName: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  addonDesc: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    marginTop: 2,
  },
  addonPrice: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.small,
    marginTop: 4,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 16,
    minWidth: 20,
    textAlign: 'center',
  },
  includesList: { gap: 10 },
  includeRow: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
  },
  includeIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  includeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  includeTitle: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  includeDetail: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    marginTop: 4,
    lineHeight: 17,
  },
  flowList: { gap: 14 },
  flowRow: { flexDirection: 'row', gap: 12 },
  flowNum: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flowNumText: { color: colors.playportOrange, fontFamily: fonts.bodyMedium, fontSize: typeScale.small },
  flowTitle: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  flowBody: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    marginTop: 4,
    lineHeight: 17,
  },
  ratingCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    alignItems: 'flex-start',
    gap: 4,
    ...shadows.soft,
  },
  bigRating: { color: colors.primaryText, fontFamily: fonts.heading, fontSize: typeScale.hero },
  stars: { color: colors.warning, fontSize: 14 },
  reviewCount: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
  reviewCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 6,
  },
  reviewHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  reviewer: { color: colors.primaryText, fontFamily: fonts.bodyMedium, fontSize: typeScale.body },
  reviewDate: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.small },
  reviewStars: { color: colors.warning, fontSize: 12 },
  reviewText: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 19,
  },
  noReviews: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.body },
  selectedLabel: { color: colors.secondaryText, fontFamily: fonts.body, fontSize: typeScale.small },
  selectedPrice: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: typeScale.title,
    marginTop: 2,
  },
  bookBtn: { minWidth: 140 },
});
