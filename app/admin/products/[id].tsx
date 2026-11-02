import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { adminStyles } from '@/components/admin/adminStyles';
import { UnitGamesEditor } from '@/components/admin/UnitGamesEditor';
import { Button } from '@/components/ui/Button';
import { colors, radii, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { adminGetProduct } from '@/lib/adminFirestore';
import { uploadProductImage } from '@/lib/productImages';
import { useAdminStore } from '@/store/adminStore';
import type { Product, ProductHourlyRate, RentalPlan } from '@/types';
import {
  DEFAULT_PLAN_TEMPLATES,
  describeControllerPrice,
  isControllerAddon,
  normalizeProduct,
  priceForAddon,
} from '@/utils/rentalPricing';
import { formatINR } from '@/utils/format';
import type { ProductAddon } from '@/types';

const EMPTY: Product = {
  id: '',
  name: '',
  shortName: '',
  description: '',
  categoryId: 'gaming',
  images: [],
  plans: DEFAULT_PLAN_TEMPLATES.map((t) => ({ ...t, price: 0 })),
  hourly: { enabled: false, firstHourPrice: 0, extraHourPrice: 0, maxHours: 24 },
  addons: [],
  compareAtPrice: undefined,
  rating: 0,
  reviewCount: 0,
  tags: [],
  badge: '',
  etaMinutes: 30,
  availabilityLabel: 'Check availability',
  includes: [],
  requirements: [],
  popular: false,
  featured: false,
};

type IncludeRow = { title: string; detail: string; tag?: string };

function num(t: string): number {
  return Number(t.replace(/[^0-9]/g, '')) || 0;
}

/** Keep a trailing dot while typing, e.g. "4." before "4.8". */
function decimalText(t: string): string {
  const cleaned = t.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  return `${cleaned.slice(0, dot + 1)}${cleaned.slice(dot + 1).replace(/\./g, '')}`;
}

export default function AdminProductEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { horizontalPadding } = useResponsive();
  const saveProduct = useAdminStore((s) => s.saveProduct);
  const categories = useAdminStore((s) => s.categories);
  const units = useAdminStore((s) => s.units);
  const hubs = useAdminStore((s) => s.hubs);
  const saveUnit = useAdminStore((s) => s.saveUnit);
  const [unitNumber, setUnitNumber] = useState('001');
  const [form, setForm] = useState<Product>(EMPTY);
  const [plans, setPlans] = useState<RentalPlan[]>(EMPTY.plans);
  const [changeFrom, setChangeFrom] = useState('');
  const [changePrices, setChangePrices] = useState<Record<string, string>>({});
  const [hourly, setHourly] = useState<ProductHourlyRate>(
    EMPTY.hourly ?? { enabled: false, firstHourPrice: 0, extraHourPrice: 0, maxHours: 24 }
  );
  const [addons, setAddons] = useState<ProductAddon[]>([]);
  const [controllerPerHour, setControllerPerHour] = useState('');
  const [controllerHourCap, setControllerHourCap] = useState('6');
  const [controllerFlat, setControllerFlat] = useState('');
  const [controllerFlatFrom, setControllerFlatFrom] = useState('12');
  const [controllerTiers, setControllerTiers] = useState<
    { upToHours: string; price: string; mode: 'flat' | 'hourly' }[]
  >([{ upToHours: '', price: '', mode: 'hourly' }]);
  const [controllerMax, setControllerMax] = useState('1');
  const [extPerHour, setExtPerHour] = useState('');
  const [extAddonPerHour, setExtAddonPerHour] = useState('');
  const [ratingText, setRatingText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [requirementsText, setRequirementsText] = useState('');
  const [includes, setIncludes] = useState<IncludeRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) {
      setForm(EMPTY);
      setPlans(EMPTY.plans);
      setChangeFrom('');
      setChangePrices({});
      setHourly(EMPTY.hourly!);
      setAddons([]);
      setControllerPerHour('');
      setControllerHourCap('6');
      setControllerFlat('');
      setControllerFlatFrom('12');
      setControllerTiers([
        { upToHours: '', price: '', mode: 'hourly' },
      ]);
      setControllerMax('1');
      setExtPerHour('');
      setExtAddonPerHour('');
      setRatingText('');
      setTagsText('');
      setRequirementsText('');
      setIncludes([]);
      return;
    }
    void (async () => {
      const p = await adminGetProduct(id);
      if (p) {
        const n = normalizeProduct({ ...EMPTY, ...p });
        setForm({ ...EMPTY, ...n, badge: n.badge ?? '', compareAtPrice: n.compareAtPrice });
        setPlans(n.plans.length ? n.plans : EMPTY.plans);
        setChangeFrom(p.priceChange?.from ?? '');
        setChangePrices(
          Object.fromEntries((p.priceChange?.plans ?? []).map((pl) => [pl.id, String(pl.price)]))
        );
        setHourly(
          n.hourly ?? { enabled: false, firstHourPrice: 0, extraHourPrice: 0, maxHours: 24 }
        );
        const ctrl = (n.addons ?? []).find((a) => isControllerAddon(a));
        setControllerPerHour(ctrl && ctrl.pricing.perHour > 0 ? String(ctrl.pricing.perHour) : '');
        setControllerHourCap(ctrl ? String(ctrl.pricing.perHourMaxPlanHours) : '6');
        setControllerFlat(ctrl && ctrl.pricing.flatPrice > 0 ? String(ctrl.pricing.flatPrice) : '');
        setControllerFlatFrom(ctrl ? String(ctrl.pricing.flatMinPlanHours) : '12');
        setControllerTiers(
          ctrl?.pricing.tiers?.length
            ? ctrl.pricing.tiers.map((t) => ({
                upToHours: String(t.upToHours),
                price: String(t.price),
                mode: t.mode ?? 'flat',
              }))
            : []
        );
        setControllerMax(ctrl ? String(ctrl.maxQuantity) : '1');
        setExtPerHour(p.extensionPricing?.perHour ? String(p.extensionPricing.perHour) : '');
        setExtAddonPerHour(p.extensionPricing?.addonPerHour ? String(p.extensionPricing.addonPerHour) : '');
        setAddons((n.addons ?? []).filter((a) => !isControllerAddon(a)));
        setRatingText(n.rating ? String(n.rating) : '');
        setTagsText((n.tags ?? []).join(', '));
        setRequirementsText((n.requirements ?? []).join('\n'));
        setIncludes((n.includes ?? []).map((i) => ({ ...i })));
      }
    })();
  }, [id, isNew]);

  const setField = <K extends keyof Product>(key: K, value: Product[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onUploadImage = async () => {
    setImageError(null);
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setImageError('Allow photo access to upload a product image.');
        return;
      }
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const productId = (isNew ? form.id : id)?.trim() || 'draft';
    setUploadingImage(true);
    try {
      const url = await uploadProductImage(productId, asset.uri, asset.mimeType ?? 'image/jpeg');
      setForm((prev) => ({
        ...prev,
        images: [...(prev.images ?? []).map((u) => u.trim()).filter(Boolean), url],
      }));
    } catch (e) {
      setImageError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingImage(false);
    }
  };

  const updatePlan = (index: number, patch: Partial<RentalPlan>) => {
    setPlans((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const updateAddon = (index: number, patch: Partial<ProductAddon>) => {
    setAddons((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const onSave = async () => {
    setError(null);
    const productId = (isNew ? form.id : id).trim();
    if (!productId || !form.name.trim()) {
      setError('ID and name are required');
      return;
    }
    const cleanedPlans = plans
      .map((p) => ({
        ...p,
        id: p.id.trim() || `${p.hours}h`,
        label: p.label.trim() || `${p.hours} Hours`,
        hours: Math.max(1, p.hours),
        price: Math.max(0, p.price),
      }))
      .filter((p) => p.id);
    if (!cleanedPlans.length) {
      setError('Add at least one rental plan');
      return;
    }
    if (form.availableFrom?.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(form.availableFrom.trim())) {
      setError('Pre-book launch date must look like 2026-11-19');
      return;
    }
    const changeDay = changeFrom.trim();
    if (changeDay && !/^\d{4}-\d{2}-\d{2}$/.test(changeDay)) {
      setError('Price change date must look like 2026-11-19');
      return;
    }
    const priceChange = changeDay
      ? {
          from: changeDay,
          plans: cleanedPlans.map((p) => ({
            ...p,
            price: Math.max(0, num(changePrices[p.id] ?? '') || p.price),
          })),
        }
      : null;
    const perHour = Math.max(0, num(controllerPerHour));
    const flatPrice = Math.max(0, num(controllerFlat));
    const tiers = controllerTiers
      .map((t) => ({
        upToHours: num(t.upToHours),
        price: num(t.price),
        mode: t.mode,
      }))
      .filter((t) => t.upToHours > 0)
      .sort((a, b) => a.upToHours - b.upToHours);
    const controllerDraft: ProductAddon = {
      id: 'extra-controller',
      name: 'Extra Controller',
      maxQuantity: Math.max(1, num(controllerMax) || 1),
      pricing: {
        perHour,
        perHourMaxPlanHours: Math.max(1, num(controllerHourCap) || 1),
        flatPrice,
        flatMinPlanHours: Math.max(1, num(controllerFlatFrom) || 1),
        ...(tiers.length ? { tiers } : {}),
      },
    };
    controllerDraft.description = describeControllerPrice(controllerDraft);
    const controllerAddon = perHour > 0 || flatPrice > 0 || tiers.length > 0 ? [controllerDraft] : [];
    setSaving(true);
    try {
      const product: Product = {
        ...form,
        id: productId,
        shortName: form.shortName.trim() || form.name.trim(),
        badge: form.badge?.trim() || undefined,
        compareAtPrice: form.compareAtPrice || undefined,
        // '' (not undefined) so clearing it overwrites the merged doc.
        availableFrom: form.availableFrom?.trim() ?? '',
        plans: cleanedPlans,
        priceChange,
        extensionPricing:
          num(extPerHour) > 0 || num(extAddonPerHour) > 0
            ? { perHour: Math.max(0, num(extPerHour)), addonPerHour: Math.max(0, num(extAddonPerHour)) }
            : null,
        hourly: hourly.enabled
          ? {
              enabled: true,
              firstHourPrice: Math.max(0, hourly.firstHourPrice),
              extraHourPrice: Math.max(0, hourly.extraHourPrice),
              maxHours: Math.max(1, hourly.maxHours ?? 24),
            }
          : { enabled: false, firstHourPrice: 0, extraHourPrice: 0, maxHours: 24 },
        addons: [
          ...controllerAddon,
          ...addons
          .filter((a) => a.id.trim() && a.name.trim() && !isControllerAddon(a))
          .map((a) => ({
            ...a,
            id: a.id.trim(),
            name: a.name.trim(),
            maxQuantity: Math.max(1, a.maxQuantity),
            pricing: {
              perHour: Math.max(0, a.pricing.perHour),
              perHourMaxPlanHours: Math.max(1, a.pricing.perHourMaxPlanHours),
              flatPrice: Math.max(0, a.pricing.flatPrice),
              flatMinPlanHours: Math.max(1, a.pricing.flatMinPlanHours),
            },
          })),
        ],
        tags: tagsText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        requirements: requirementsText
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean),
        rating: Number.isFinite(Number(ratingText)) ? Math.max(0, Number(ratingText) || 0) : 0,
        images: (form.images ?? []).map((u) => u.trim()).filter(Boolean),
        includes: includes
          .map((row) => ({
            title: row.title.trim(),
            detail: row.detail.trim() || row.title.trim(),
            tag: row.tag?.trim() || undefined,
          }))
          .filter((row) => row.title),
      };
      // Drop legacy field so Firestore stores the new shape
      delete (product as { priceByDuration?: unknown }).priceByDuration;
      await saveProduct(product);
      router.replace('/admin/products' as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions =
    categories.length > 0
      ? categories
      : [{ id: form.categoryId || 'gaming', shortName: form.categoryId || 'gaming', name: '' }];

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[adminStyles.scroll, { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl }]}
    >
      <Text style={adminStyles.title}>{isNew ? 'New product' : 'Edit product'}</Text>
      <Text style={adminStyles.subtitle}>{isNew ? 'Plans, hourly rates, and add-ons' : id}</Text>

      <Text style={adminStyles.cardTitle}>Identity</Text>
      {isNew ? (
        <View style={adminStyles.field}>
          <Text style={adminStyles.label}>ID (slug)</Text>
          <TextInput
            style={adminStyles.input}
            value={form.id}
            onChangeText={(t) => setField('id', t.trim().toLowerCase().replace(/\s+/g, '-'))}
            placeholder="ps5-slim"
            placeholderTextColor={colors.mutedText}
            autoCapitalize="none"
          />
        </View>
      ) : null}

      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Name</Text>
        <TextInput
          style={adminStyles.input}
          value={form.name}
          onChangeText={(t) => setField('name', t)}
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Short name</Text>
        <TextInput
          style={adminStyles.input}
          value={form.shortName}
          onChangeText={(t) => setField('shortName', t)}
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Description — shows on the product page under the title</Text>
        <TextInput
          style={[adminStyles.input, { minHeight: 100, textAlignVertical: 'top' }]}
          value={form.description}
          onChangeText={(t) => setField('description', t)}
          multiline
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Badge (optional)</Text>
        <TextInput
          style={adminStyles.input}
          value={form.badge ?? ''}
          onChangeText={(t) => setField('badge', t)}
          placeholder="Bestseller, New…"
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>Category</Text>
      <View style={adminStyles.row}>
        {categoryOptions.map((c) => {
          const active = form.categoryId === c.id;
          return (
            <Button
              key={c.id}
              title={c.shortName || c.id}
              size="sm"
              variant={active ? 'primary' : 'secondary'}
              onPress={() => setField('categoryId', c.id)}
            />
          );
        })}
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Or type category ID</Text>
        <TextInput
          style={adminStyles.input}
          value={form.categoryId}
          onChangeText={(t) => setField('categoryId', t.trim().toLowerCase())}
          autoCapitalize="none"
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>Rental plans</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.sm }]}>
        Package prices customers pick on the product page
      </Text>
      <View style={[adminStyles.row, { marginBottom: spacing.md, flexWrap: 'wrap', gap: 8 }]}>
        <Button
          title="Load flyer defaults (1/3/6/12/24)"
          size="sm"
          variant="secondary"
          onPress={() =>
            setPlans(DEFAULT_PLAN_TEMPLATES.map((t) => ({ ...t, price: 0 })))
          }
        />
        <Button
          title="Add plan"
          size="sm"
          variant="secondary"
          onPress={() =>
            setPlans((prev) => [
              ...prev,
              { id: `${prev.length + 1}h`, label: 'New plan', hours: 1, price: 0 },
            ])
          }
        />
      </View>
      {plans.map((plan, index) => (
        <View key={`plan-${index}`} style={adminStyles.card}>
          <View style={adminStyles.row}>
            <View style={[adminStyles.field, { flex: 1, marginBottom: 0 }]}>
              <Text style={adminStyles.label}>ID</Text>
              <TextInput
                style={adminStyles.input}
                value={plan.id}
                onChangeText={(t) => updatePlan(index, { id: t.trim().toLowerCase() })}
                autoCapitalize="none"
                placeholderTextColor={colors.mutedText}
              />
            </View>
            <View style={[adminStyles.field, { flex: 1.4, marginBottom: 0, marginLeft: 8 }]}>
              <Text style={adminStyles.label}>Label</Text>
              <TextInput
                style={adminStyles.input}
                value={plan.label}
                onChangeText={(t) => updatePlan(index, { label: t })}
                placeholderTextColor={colors.mutedText}
              />
            </View>
          </View>
          <View style={[adminStyles.row, { marginTop: 8 }]}>
            <View style={[adminStyles.field, { flex: 1, marginBottom: 0 }]}>
              <Text style={adminStyles.label}>Hours</Text>
              <TextInput
                style={adminStyles.input}
                keyboardType="numeric"
                value={plan.hours > 0 ? String(plan.hours) : ''}
                onChangeText={(t) => updatePlan(index, { hours: num(t) })}
                placeholderTextColor={colors.mutedText}
              />
            </View>
            <View style={[adminStyles.field, { flex: 1, marginBottom: 0, marginLeft: 8 }]}>
              <Text style={adminStyles.label}>Price ₹</Text>
              <TextInput
                style={adminStyles.input}
                keyboardType="numeric"
                value={String(plan.price)}
                onChangeText={(t) => updatePlan(index, { price: num(t) })}
                placeholderTextColor={colors.mutedText}
              />
            </View>
            <View style={{ justifyContent: 'center', marginLeft: 8, paddingTop: 18 }}>
              <Text style={[adminStyles.label, { marginBottom: 4 }]}>Popular</Text>
              <Switch
                value={!!plan.popular}
                onValueChange={(v) => updatePlan(index, { popular: v })}
                trackColor={{ true: colors.playportOrange }}
              />
            </View>
          </View>
          <Pressable
            onPress={() => setPlans((prev) => prev.filter((_, i) => i !== index))}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: colors.danger }}>Remove plan</Text>
          </Pressable>
        </View>
      ))}

      <Text style={adminStyles.cardTitle}>Scheduled price change</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.sm }]}>
        Rentals starting on or after this day use the new prices below — including pre-bookings made now.
        Leave the date empty for no change.
      </Text>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>New prices from (YYYY-MM-DD)</Text>
        <TextInput
          style={adminStyles.input}
          value={changeFrom}
          onChangeText={setChangeFrom}
          placeholder="2026-11-19"
          autoCapitalize="none"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      {changeFrom.trim()
        ? plans.map((plan) => (
            <View key={`change-${plan.id}`} style={[adminStyles.row, { marginBottom: 8 }]}>
              <Text style={[adminStyles.label, { flex: 1, marginBottom: 0 }]}>
                {plan.label} (now ₹{plan.price})
              </Text>
              <TextInput
                style={[adminStyles.input, { flex: 1 }]}
                keyboardType="numeric"
                value={changePrices[plan.id] ?? ''}
                onChangeText={(t) => setChangePrices((prev) => ({ ...prev, [plan.id]: t }))}
                placeholder={`New ₹ (blank = ₹${plan.price})`}
                placeholderTextColor={colors.mutedText}
              />
            </View>
          ))
        : null}

      <Text style={adminStyles.cardTitle}>Hourly rates</Text>
      <View style={[adminStyles.row, { marginBottom: spacing.md }]}>
        <Text style={[adminStyles.label, { marginBottom: 0, flex: 1 }]}>Enable hourly mode</Text>
        <Switch
          value={hourly.enabled}
          onValueChange={(v) => setHourly((h) => ({ ...h, enabled: v }))}
          trackColor={{ true: colors.playportOrange }}
        />
      </View>
      {hourly.enabled ? (
        <>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>First hour ₹</Text>
            <TextInput
              style={adminStyles.input}
              keyboardType="numeric"
              value={String(hourly.firstHourPrice)}
              onChangeText={(t) => setHourly((h) => ({ ...h, firstHourPrice: num(t) }))}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>Every extra hour ₹</Text>
            <TextInput
              style={adminStyles.input}
              keyboardType="numeric"
              value={String(hourly.extraHourPrice)}
              onChangeText={(t) => setHourly((h) => ({ ...h, extraHourPrice: num(t) }))}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>Max hours</Text>
            <TextInput
              style={adminStyles.input}
              keyboardType="numeric"
              value={String(hourly.maxHours ?? 24)}
              onChangeText={(t) => setHourly((h) => ({ ...h, maxHours: num(t) || 24 }))}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <Text style={[adminStyles.subtitle, { marginBottom: spacing.md }]}>
            Extended hourly cannot convert to package prices later
          </Text>
        </>
      ) : null}

      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Compare-at price (strike-through, optional)</Text>
        <TextInput
          style={adminStyles.input}
          keyboardType="numeric"
          value={form.compareAtPrice != null ? String(form.compareAtPrice) : ''}
          onChangeText={(t) => {
            const n = num(t);
            setField('compareAtPrice', n || undefined);
          }}
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>Extra controller for this product</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.md }]}>
        Price per session length — e.g. ₹20/hr up to 6h, or a ₹150 flat fee up to 24h.
        The customer pays the first tier that covers their hours. Leave all rows empty to hide
        extra controllers on the product page.
      </Text>
      {controllerTiers.map((tier, index) => (
        <View key={`tier-${index}`} style={adminStyles.card}>
          <View style={adminStyles.row}>
            <View style={[adminStyles.field, { flex: 1, marginBottom: 8 }]}>
              <Text style={adminStyles.label}>Up to hours</Text>
              <TextInput
                style={adminStyles.input}
                keyboardType="numeric"
                value={tier.upToHours}
                onChangeText={(t) =>
                  setControllerTiers((prev) => prev.map((r, i) => (i === index ? { ...r, upToHours: t } : r)))
                }
                placeholder="6"
                placeholderTextColor={colors.mutedText}
              />
            </View>
            <View style={[adminStyles.field, { flex: 1, marginBottom: 8, marginLeft: 8 }]}>
              <Text style={adminStyles.label}>₹ amount</Text>
              <TextInput
                style={adminStyles.input}
                keyboardType="numeric"
                value={tier.price}
                onChangeText={(t) =>
                  setControllerTiers((prev) => prev.map((r, i) => (i === index ? { ...r, price: t } : r)))
                }
                placeholder={tier.mode === 'hourly' ? '20' : '100'}
                placeholderTextColor={colors.mutedText}
              />
            </View>
          </View>
          <View style={[adminStyles.row, { marginTop: 4 }]}>
            {(['hourly', 'flat'] as const).map((m) => {
              const on = tier.mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() =>
                    setControllerTiers((prev) => prev.map((r, i) => (i === index ? { ...r, mode: m } : r)))
                  }
                  style={[adminStyles.chip, on && adminStyles.chipActive]}
                >
                  <Text style={[adminStyles.chipText, on && adminStyles.chipTextActive]}>
                    {m === 'hourly' ? '₹ per hour' : 'Flat fee'}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setControllerTiers((prev) => prev.filter((_, i) => i !== index))}
              style={{ justifyContent: 'center', marginLeft: 'auto' }}
            >
              <Text style={{ color: colors.danger }}>Remove</Text>
            </Pressable>
          </View>
          <Text style={[adminStyles.cardMeta, { marginTop: 6 }]}>
            {tier.mode === 'hourly'
              ? 'Customer pays this ₹ × session hours'
              : 'Customer pays this ₹ once per session'}
          </Text>
        </View>
      ))}
      <Button
        title="Add price tier"
        size="sm"
        variant="secondary"
        onPress={() => setControllerTiers((prev) => [...prev, { upToHours: '', price: '', mode: 'hourly' }])}
      />
      <Text style={[adminStyles.label, { marginTop: 12 }]}>Fallback hourly (only if no tiers above)</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.sm }]}>
        Used only when every tier row is empty or removed.
      </Text>
      <Text style={adminStyles.label}>₹ per hour, used until the hour cap</Text>
      <View style={adminStyles.row}>
        <TextInput
          style={[adminStyles.input, { flex: 1 }]}
          keyboardType="numeric"
          value={controllerPerHour}
          onChangeText={setControllerPerHour}
          placeholder="20"
          placeholderTextColor={colors.mutedText}
        />
        <TextInput
          style={[adminStyles.input, { flex: 1, marginLeft: 8 }]}
          keyboardType="numeric"
          value={controllerHourCap}
          onChangeText={setControllerHourCap}
          placeholder="Up to hours"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <Text style={[adminStyles.label, { marginTop: 8 }]}>Flat ₹, used from this many hours</Text>
      <View style={adminStyles.row}>
        <TextInput
          style={[adminStyles.input, { flex: 1 }]}
          keyboardType="numeric"
          value={controllerFlat}
          onChangeText={setControllerFlat}
          placeholder="150"
          placeholderTextColor={colors.mutedText}
        />
        <TextInput
          style={[adminStyles.input, { flex: 1, marginLeft: 8 }]}
          keyboardType="numeric"
          value={controllerFlatFrom}
          onChangeText={setControllerFlatFrom}
          placeholder="From hours"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={[adminStyles.field, { marginTop: 8 }]}>
        <Text style={adminStyles.label}>Max extra controllers a customer can add</Text>
        <TextInput
          style={adminStyles.input}
          keyboardType="numeric"
          value={controllerMax}
          onChangeText={setControllerMax}
          placeholder="1"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <Text style={adminStyles.cardTitle}>Extension prices</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.sm }]}>
        What a customer pays per extra hour when extending a live rental. Leave empty to price extensions
        from the hour packages above.
      </Text>
      <View style={adminStyles.row}>
        <View style={[adminStyles.field, { flex: 1 }]}>
          <Text style={adminStyles.label}>Kit ₹ per extra hour</Text>
          <TextInput
            style={adminStyles.input}
            keyboardType="numeric"
            value={extPerHour}
            onChangeText={setExtPerHour}
            placeholder="150"
            placeholderTextColor={colors.mutedText}
          />
        </View>
        <View style={[adminStyles.field, { flex: 1, marginLeft: 8 }]}>
          <Text style={adminStyles.label}>Each extra controller ₹ per hour</Text>
          <TextInput
            style={adminStyles.input}
            keyboardType="numeric"
            value={extAddonPerHour}
            onChangeText={setExtAddonPerHour}
            placeholder="20"
            placeholderTextColor={colors.mutedText}
          />
        </View>
      </View>
      <ControllerPricePreview
        perHour={controllerPerHour}
        hourCap={controllerHourCap}
        flat={controllerFlat}
        flatFrom={controllerFlatFrom}
        tiers={controllerTiers}
        plans={plans}
      />

      <Text style={adminStyles.cardTitle}>Selectable consoles</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.md }]}>
        Each row is a choice on the product, separate from the product itself. Name it what the customer should tap (PS5 Slim, PS5 with FIFA) and list only the games on that console.
      </Text>
      {isNew ? (
        <Text style={[adminStyles.subtitle, { marginBottom: spacing.lg }]}>
          Save the product first, then add PS4 #1, PS4 #2, and their games here.
        </Text>
      ) : (
        <View style={{ gap: spacing.md, marginBottom: spacing.lg }}>
          {units.filter((u) => u.productId === id).map((unit) => (
            <View key={unit.id} style={adminStyles.card}>
              <UnitGamesEditor
                unit={unit}
                productName={form.shortName || form.name}
                onSave={(patch) =>
                  saveUnit({ ...unit, ...patch, updatedAt: new Date().toISOString() })
                }
              />
            </View>
          ))}
          <View style={adminStyles.card}>
            <Text style={adminStyles.label}>Add a unit number</Text>
            <TextInput
              style={adminStyles.input}
              value={unitNumber}
              onChangeText={setUnitNumber}
              placeholder="001"
              placeholderTextColor={colors.mutedText}
              keyboardType="numeric"
            />
            <Button
              title="Create unit"
              size="sm"
              variant="secondary"
              onPress={() => {
                const n = unitNumber.padStart(3, '0');
                const now = new Date().toISOString();
                const skuLabel = `${(form.shortName || form.name || id).toUpperCase().replace(/\s+/g, '-')}-${n}`;
                void saveUnit({
                  id: `${id}-${n}`,
                  productId: id,
                  hubId: hubs[0]?.id ?? 'indiranagar',
                  skuLabel,
                  status: 'available',
                  games: [],
                  createdAt: now,
                  updatedAt: now,
                });
                setUnitNumber(String(Number(n) + 1).padStart(3, '0'));
              }}
            />
          </View>
        </View>
      )}

      <Text style={adminStyles.cardTitle}>Add-ons</Text>
      <View style={[adminStyles.row, { marginBottom: spacing.md, flexWrap: 'wrap', gap: 8 }]}>
        <Button
          title="Add blank add-on"
          size="sm"
          variant="secondary"
          onPress={() =>
            setAddons((prev) => [
              ...prev,
              {
                id: `addon-${prev.length + 1}`,
                name: '',
                maxQuantity: 2,
                pricing: {
                  perHour: 20,
                  perHourMaxPlanHours: 6,
                  flatPrice: 150,
                  flatMinPlanHours: 12,
                },
              },
            ])
          }
        />
      </View>
      {addons.map((addon, index) => (
        <View key={`addon-${index}`} style={adminStyles.card}>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>ID</Text>
            <TextInput
              style={adminStyles.input}
              value={addon.id}
              onChangeText={(t) => updateAddon(index, { id: t.trim().toLowerCase() })}
              autoCapitalize="none"
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>Name</Text>
            <TextInput
              style={adminStyles.input}
              value={addon.name}
              onChangeText={(t) => updateAddon(index, { name: t })}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>Description</Text>
            <TextInput
              style={adminStyles.input}
              value={addon.description ?? ''}
              onChangeText={(t) => updateAddon(index, { description: t })}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <View style={adminStyles.field}>
            <Text style={adminStyles.label}>Max quantity</Text>
            <TextInput
              style={adminStyles.input}
              keyboardType="numeric"
              value={String(addon.maxQuantity)}
              onChangeText={(t) => updateAddon(index, { maxQuantity: num(t) || 1 })}
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <Text style={adminStyles.label}>Per-hour ₹ (when plan hours ≤ threshold)</Text>
          <View style={adminStyles.row}>
            <TextInput
              style={[adminStyles.input, { flex: 1 }]}
              keyboardType="numeric"
              value={String(addon.pricing.perHour)}
              onChangeText={(t) =>
                updateAddon(index, {
                  pricing: { ...addon.pricing, perHour: num(t) },
                })
              }
              placeholderTextColor={colors.mutedText}
            />
            <TextInput
              style={[adminStyles.input, { flex: 1, marginLeft: 8 }]}
              keyboardType="numeric"
              value={String(addon.pricing.perHourMaxPlanHours)}
              onChangeText={(t) =>
                updateAddon(index, {
                  pricing: { ...addon.pricing, perHourMaxPlanHours: num(t) || 6 },
                })
              }
              placeholder="Max hrs"
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <Text style={[adminStyles.label, { marginTop: 8 }]}>
            Flat ₹ (when plan hours ≥ threshold)
          </Text>
          <View style={adminStyles.row}>
            <TextInput
              style={[adminStyles.input, { flex: 1 }]}
              keyboardType="numeric"
              value={String(addon.pricing.flatPrice)}
              onChangeText={(t) =>
                updateAddon(index, {
                  pricing: { ...addon.pricing, flatPrice: num(t) },
                })
              }
              placeholderTextColor={colors.mutedText}
            />
            <TextInput
              style={[adminStyles.input, { flex: 1, marginLeft: 8 }]}
              keyboardType="numeric"
              value={String(addon.pricing.flatMinPlanHours)}
              onChangeText={(t) =>
                updateAddon(index, {
                  pricing: { ...addon.pricing, flatMinPlanHours: num(t) || 12 },
                })
              }
              placeholder="Min hrs"
              placeholderTextColor={colors.mutedText}
            />
          </View>
          <Pressable
            onPress={() => setAddons((prev) => prev.filter((_, i) => i !== index))}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: colors.danger }}>Remove add-on</Text>
          </Pressable>
        </View>
      ))}

      <Text style={adminStyles.cardTitle}>Media & discovery</Text>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Product photos</Text>
        <Text style={[adminStyles.cardMeta, { marginBottom: 8 }]}>
          Upload a picture from your device. JPG, PNG, or WEBP, under 5 MB.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {(form.images ?? []).filter((uri) => uri.trim()).map((uri) => (
            <View key={uri} style={{ width: 96 }}>
              <Image
                source={{ uri }}
                style={{ width: 96, height: 96, borderRadius: radii.md, backgroundColor: colors.surfaceAlt }}
                contentFit="cover"
              />
              <Pressable
                onPress={() =>
                  setForm((prev) => ({
                    ...prev,
                    images: (prev.images ?? []).filter((item) => item !== uri),
                  }))
                }
                style={{ marginTop: 4 }}
              >
                <Text style={{ color: colors.danger, fontSize: 12 }}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
        <View style={{ marginTop: 10, alignSelf: 'flex-start' }}>
          <Button
            title={uploadingImage ? 'Uploading…' : 'Upload image'}
            variant="secondary"
            disabled={uploadingImage}
            onPress={() => void onUploadImage()}
          />
        </View>
        {imageError ? <Text style={{ color: colors.danger, marginTop: 8 }}>{imageError}</Text> : null}
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>
          Tags — comma-separated, e.g. gaming, ps5, family{tagsText.trim() ? ` · ${tagsText.split(',').map((t) => t.trim()).filter(Boolean).length} tags` : ''}
        </Text>
        <TextInput
          style={adminStyles.input}
          value={tagsText}
          onChangeText={setTagsText}
          placeholder="gaming, ps5, family"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>
          Pre-book launch date (optional, YYYY-MM-DD) — rentals can’t start before this day
        </Text>
        <TextInput
          style={adminStyles.input}
          value={form.availableFrom ?? ''}
          onChangeText={(t) => setField('availableFrom', t)}
          placeholder="2026-11-19"
          autoCapitalize="none"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Availability label</Text>
        <TextInput
          style={adminStyles.input}
          value={form.availabilityLabel}
          onChangeText={(t) => setField('availabilityLabel', t)}
          placeholder="3 units at hub"
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>ETA minutes</Text>
        <TextInput
          style={adminStyles.input}
          keyboardType="numeric"
          value={String(form.etaMinutes ?? 30)}
          onChangeText={(t) => setField('etaMinutes', num(t) || 30)}
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Rating (display)</Text>
        <TextInput
          style={adminStyles.input}
          keyboardType="decimal-pad"
          value={ratingText}
          onChangeText={(t) => setRatingText(decimalText(t))}
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Review count (display)</Text>
        <TextInput
          style={adminStyles.input}
          keyboardType="numeric"
          value={String(form.reviewCount ?? 0)}
          onChangeText={(t) => setField('reviewCount', num(t))}
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>What’s included{includes.length ? ` (${includes.filter((r) => r.title.trim()).length} rows)` : ''}</Text>
      <Text style={[adminStyles.subtitle, { marginBottom: spacing.md }]}>
        What comes in the box with this package — each row needs a title; the detail can be left
        blank and the title will be used. Rows with an empty title are skipped on save.
      </Text>
      {includes.map((row, index) => (
        <View key={`inc-${index}`} style={adminStyles.card}>
          <TextInput
            style={adminStyles.input}
            value={row.title}
            onChangeText={(t) =>
              setIncludes((prev) => prev.map((r, i) => (i === index ? { ...r, title: t } : r)))
            }
            placeholder="Title"
            placeholderTextColor={colors.mutedText}
          />
          <TextInput
            style={[adminStyles.input, { marginTop: 8 }]}
            value={row.detail}
            onChangeText={(t) =>
              setIncludes((prev) => prev.map((r, i) => (i === index ? { ...r, detail: t } : r)))
            }
            placeholder="Detail"
            placeholderTextColor={colors.mutedText}
          />
          <TextInput
            style={[adminStyles.input, { marginTop: 8 }]}
            value={row.tag ?? ''}
            onChangeText={(t) =>
              setIncludes((prev) => prev.map((r, i) => (i === index ? { ...r, tag: t } : r)))
            }
            placeholder="Tag (optional)"
            placeholderTextColor={colors.mutedText}
          />
          <Pressable
            onPress={() => setIncludes((prev) => prev.filter((_, i) => i !== index))}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: colors.danger }}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <Button
        title="Add include row"
        size="sm"
        variant="secondary"
        onPress={() => setIncludes((prev) => [...prev, { title: '', detail: '', tag: '' }])}
      />

      <Text style={[adminStyles.cardTitle, { marginTop: spacing.lg }]}>Requirements</Text>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>
          One requirement per line{requirementsText.trim() ? ` · ${requirementsText.split('\n').map((t) => t.trim()).filter(Boolean).length} requirements` : ''}
        </Text>
        <TextInput
          style={[adminStyles.input, { minHeight: 88, textAlignVertical: 'top' }]}
          value={requirementsText}
          onChangeText={setRequirementsText}
          multiline
          placeholder="TV with HDMI&#10;Power outlet"
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>Flags</Text>
      <View style={[adminStyles.row, { marginBottom: spacing.md }]}>
        <Text style={[adminStyles.label, { marginBottom: 0, flex: 1 }]}>Featured</Text>
        <Switch
          value={!!form.featured}
          onValueChange={(v) => setField('featured', v)}
          trackColor={{ true: colors.playportOrange }}
        />
      </View>
      <View style={[adminStyles.row, { marginBottom: spacing.md }]}>
        <Text style={[adminStyles.label, { marginBottom: 0, flex: 1 }]}>Popular</Text>
        <Switch
          value={!!form.popular}
          onValueChange={(v) => setField('popular', v)}
          trackColor={{ true: colors.playportOrange }}
        />
      </View>

      {error ? <Text style={adminStyles.error}>{error}</Text> : null}

      <View style={adminStyles.row}>
        <Button title="Cancel" variant="ghost" size="sm" onPress={() => router.back()} />
        <Button title={saving ? 'Saving…' : 'Save product'} size="sm" disabled={saving} onPress={() => void onSave()} />
      </View>
    </ScrollView>
  );
}

function ControllerPricePreview({
  perHour,
  hourCap,
  flat,
  flatFrom,
  tiers,
  plans,
}: {
  perHour: string;
  hourCap: string;
  flat: string;
  flatFrom: string;
  tiers: { upToHours: string; price: string; mode: 'flat' | 'hourly' }[];
  plans: RentalPlan[];
}) {
  const parsedTiers = tiers
    .map((t) => ({ upToHours: num(t.upToHours), price: num(t.price), mode: t.mode }))
    .filter((t) => t.upToHours > 0)
    .sort((a, b) => a.upToHours - b.upToHours);
  const draft: ProductAddon = {
    id: 'extra-controller',
    name: 'Extra Controller',
    maxQuantity: 1,
    pricing: {
      perHour: Math.max(0, num(perHour)),
      perHourMaxPlanHours: Math.max(1, num(hourCap) || 1),
      flatPrice: Math.max(0, num(flat)),
      flatMinPlanHours: Math.max(1, num(flatFrom) || 1),
      ...(parsedTiers.length ? { tiers: parsedTiers } : {}),
    },
  };
  if (draft.pricing.perHour <= 0 && draft.pricing.flatPrice <= 0 && !parsedTiers.length) {
    return (
      <Text style={[adminStyles.subtitle, { marginTop: 8, marginBottom: spacing.lg }]}>
        Hidden on the product page until you set an hourly, flat, or tier price.
      </Text>
    );
  }
  return (
    <View style={{ marginTop: 8, marginBottom: spacing.lg, gap: 4 }}>
      <Text style={adminStyles.label}>Customer sees</Text>
      <Text style={adminStyles.cardMeta}>{describeControllerPrice(draft)}</Text>
      {plans
        .filter((p) => p.hours > 0)
        .map((p) => (
          <Text key={p.id || String(p.hours)} style={adminStyles.cardMeta}>
            {p.label || `${p.hours}h`} · {formatINR(priceForAddon(draft, p.hours, 1))} each
          </Text>
        ))}
    </View>
  );
}
