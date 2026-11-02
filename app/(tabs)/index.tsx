import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/layout/Screen';
import { OrderingPausedBanner } from '@/components/layout/OrderingPausedBanner';
import { ServiceAreaBanner } from '@/components/layout/ServiceAreaBanner';
import { ServiceHoursBanner } from '@/components/layout/ServiceHoursBanner';
import { ResponsiveGrid } from '@/components/layout/ResponsiveGrid';
import { LegalLinks } from '@/components/legal/LegalLinks';
import { ProductCard } from '@/components/products/ProductCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { colors, fonts, layout, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore, useCartCount } from '@/store/appStore';
import { unitBookableFor } from '@/utils/launch';
import { useCatalogStore } from '@/store/catalogStore';
import { useFeelStore } from '@/store/feelStore';
import { useWishlistStore } from '@/store/wishlistStore';
import { gateCartAdd } from '@/utils/authGate';
import type { CardSelection } from '@/components/products/ProductCard';

const CARD_GAP = 16;

export default function HomeScreen() {
  const { horizontalPadding, productColumns, gap, isDesktop, isTablet } = useResponsive();
  const cartCount = useCartCount();
  const [viewport, setViewport] = useState(0);
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const addProductToCart = useAppStore((s) => s.addProductToCart);
  const updateCartQuantity = useAppStore((s) => s.updateCartQuantity);
  const cart = useAppStore((s) => s.cart);
  const scheduledStartAt = useAppStore((s) => s.scheduledStartAt);
  const showToast = useFeelStore((s) => s.showToast);
  const products = useCatalogStore((s) => s.products);
  const units = useCatalogStore((s) => s.units);
  const ready = useCatalogStore((s) => s.ready);
  const catalogError = useCatalogStore((s) => s.error);
  const hydrate = useCatalogStore((s) => s.hydrate);
  const wishlist = useWishlistStore((s) => s.ids);
  const toggleWishlist = useWishlistStore((s) => s.toggle);

  const lineFor = (productId: string, selection: CardSelection) =>
    cart.find(
      (item) =>
        item.productId === productId &&
        item.planId === selection.planId &&
        (item.inventoryUnitId ?? '') === (selection.inventoryUnitId ?? '')
    );

  const addKit = (product: (typeof products)[0], selection: CardSelection) => {
    const unit = units.find((item) => item.id === selection.inventoryUnitId);
    const options = {
      planId: selection.planId,
      inventoryUnitId: selection.inventoryUnitId,
      unitLabel: unit?.skuLabel,
    };
    if (!gateCartAdd('/(tabs)', { kind: 'product', productId: product.id, options })) return;
    addProductToCart(product.id, options);
    showToast(`Added ${product.shortName}`);
  };

  const cartInset = cartCount > 0 ? layout.floatingCartHeight + 20 : 0;
  // Phones keep the full-bleed peek + snap cards. Tablets and desktops get a
  // proper multi-column grid — one giant card per screen looks broken there.
  const gridMode = isTablet || isDesktop;
  const visible = Math.max(viewport - cartInset, 0);
  // Peek cards give the photo whatever the text block doesn't take — a taller
  // frame keeps phone photos long on every screen size.
  // Card height intentionally ignores the cart inset: otherwise every card
  // resizes (and snap points jump) the moment the floating cart bar appears.
  const cardHeight = viewport > 0 ? (viewport - CARD_GAP) / 1.32 : 0;
  const stride = cardHeight + CARD_GAP;

  const renderCard = (product: (typeof products)[0]) => (
    <ProductCard
      fill={!gridMode}
      showUnitOptions={false}
      product={product}
      wished={wishlist.includes(product.id)}
      onToggleWishlist={() => toggleWishlist(product.id)}
      units={units.filter((unit) => unit.productId === product.id && unitBookableFor(unit, scheduledStartAt))}
      quantityFor={(selection) => lineFor(product.id, selection)?.quantity ?? 0}
      onPress={() => router.push(`/product/${product.id}`)}
      onAdd={(selection) => addKit(product, selection)}
      onIncrement={(selection) => addKit(product, selection)}
      onDecrement={(selection) => {
        if (!isAuthenticated) return;
        const line = lineFor(product.id, selection);
        if (line) updateCartQuantity(line.id, line.quantity - 1);
      }}
    />
  );

  return (
    <Screen showCart showFloatingCart showSearch>
      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        onLayout={gridMode ? undefined : (event) => setViewport(event.nativeEvent.layout.height)}
        snapToInterval={!gridMode && stride > 0 ? stride : undefined}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum={!gridMode}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: gridMode ? spacing.lg : 0,
          paddingBottom: gridMode
            ? spacing.huge
            : cardHeight > 0
              ? Math.max(visible - cardHeight, spacing.lg)
              : spacing.huge,
          backgroundColor: colors.surfaceAlt,
          flexGrow: 1,
        }}
      >
        {!ready ? (
          <ActivityIndicator color={colors.playportOrange} style={{ marginTop: 24 }} />
        ) : products.length && (gridMode || cardHeight > 0) ? (
          gridMode ? (
            <>
              <OrderingPausedBanner />
              <ServiceAreaBanner />
              <ServiceHoursBanner />
              <View style={styles.heading}>
                <Text style={styles.headingTitle}>Kits at your hub</Text>
                <Text style={styles.headingSub}>
                  {products.length} available · delivered & set up
                </Text>
              </View>
              <ResponsiveGrid columns={productColumns} gap={gap}>
                {products.map((product) => (
                  <View key={product.id}>{renderCard(product)}</View>
                ))}
              </ResponsiveGrid>
              <LegalLinks />
            </>
          ) : (
            <>
              <OrderingPausedBanner style={{ marginTop: spacing.md }} />
              <ServiceAreaBanner />
              <ServiceHoursBanner />
              {products.map((product) => (
              <View key={product.id} style={{ height: cardHeight, marginBottom: CARD_GAP }}>
                {renderCard(product)}
              </View>
              ))}
              <LegalLinks />
            </>
          )
        ) : products.length ? null : (
          <EmptyState
            icon="cube-outline"
            title="No products yet"
            subtitle={
              catalogError ||
              'The store catalog is empty. Check back soon or ask ops to add kits in Admin.'
            }
            actionLabel="Retry"
            onAction={() => void hydrate()}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
  },
  heading: { marginBottom: 4 },
  headingTitle: { fontFamily: fonts.heading, fontSize: typeScale.display, color: colors.primaryText },
  headingSub: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.secondaryText, marginTop: 2 },
});
