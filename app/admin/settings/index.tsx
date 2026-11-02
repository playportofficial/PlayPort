import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { adminStyles } from '@/components/admin/adminStyles';
import { Button } from '@/components/ui/Button';
import { colors, spacing } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAdminStore } from '@/store/adminStore';
import type { AppConfig } from '@/types';
import { DEFAULT_APP_CONFIG } from '@/types';

export default function AdminSettingsScreen() {
  const { horizontalPadding } = useResponsive();
  const config = useAdminStore((s) => s.config);
  const saveConfig = useAdminStore((s) => s.saveConfig);
  const loadConfig = useAdminStore((s) => s.loadConfig);
  const [form, setForm] = useState<AppConfig>({ ...DEFAULT_APP_CONFIG });
  const [pincodesText, setPincodesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    setForm({ ...DEFAULT_APP_CONFIG, ...config });
    setPincodesText((config.rapidZonePincodes ?? []).join(', '));
  }, [config]);

  const setNum = (key: keyof AppConfig, raw: string) => {
    const n = Number(raw.replace(/[^0-9.]/g, '')) || 0;
    setForm((f) => ({ ...f, [key]: n }));
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveConfig({
        ...form,
        rapidZonePincodes: pincodesText
          .split(/[,\s]+/)
          .map((p) => p.trim())
          .filter(Boolean),
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={adminStyles.page}
      contentContainerStyle={[adminStyles.scroll, { paddingHorizontal: horizontalPadding, paddingTop: spacing.xl }]}
    >
      <Text style={adminStyles.title}>Settings</Text>
      <Text style={adminStyles.subtitle}>Global ops parameters · stored in config/app</Text>

      <Text style={adminStyles.cardTitle}>Commerce</Text>
      {(
        [
          ['taxPercent', 'Tax percent'],
          ['deliveryFee', 'Delivery fee (₹)'],
          ['freeDeliveryAbove', 'Free delivery above (₹)'],
          ['minOrderAmount', 'Minimum order (₹)'],
          ['maxUnitsPerOrder', 'Max units per order'],
          ['defaultEtaMinutes', 'Default ETA minutes'],
          ['bookingHoldMinutes', 'Payment hold minutes'],
          ['bufferBeforeMinutes', 'Buffer before each rental (min) — rider travel out'],
          ['bufferAfterMinutes', 'Buffer after each rental (min) — pickup, ride back, cleaning'],
          ['controllerStock', 'Spare controllers in stock (shared by all kits)'],
        ] as const
      ).map(([key, label]) => (
        <View key={key} style={adminStyles.field}>
          <Text style={adminStyles.label}>{label}</Text>
          <TextInput
            style={adminStyles.input}
            keyboardType="numeric"
            value={String(form[key] ?? 0)}
            onChangeText={(t) => setNum(key, t)}
            placeholderTextColor={colors.mutedText}
          />
        </View>
      ))}

      <Text style={adminStyles.cardTitle}>Support & brand</Text>
      {(
        [
          ['supportPhone', 'Support phone'],
          ['supportEmail', 'Support email'],
          ['supportWhatsapp', 'Support WhatsApp'],
          ['brandTagline', 'Brand tagline'],
          ['homeHeroTitle', 'Home hero title'],
          ['homeHeroSubtitle', 'Home hero subtitle'],
        ] as const
      ).map(([key, label]) => (
        <View key={key} style={adminStyles.field}>
          <Text style={adminStyles.label}>{label}</Text>
          <TextInput
            style={adminStyles.input}
            value={String(form[key] ?? '')}
            onChangeText={(t) => setForm((f) => ({ ...f, [key]: t }))}
            placeholderTextColor={colors.mutedText}
          />
        </View>
      ))}

      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Rapid-zone pincodes (comma-separated)</Text>
        <TextInput
          style={adminStyles.input}
          value={pincodesText}
          onChangeText={setPincodesText}
          placeholder="560038, 560001"
          placeholderTextColor={colors.mutedText}
        />
      </View>

      <Text style={adminStyles.cardTitle}>Flags</Text>
      <View style={[adminStyles.row, { marginBottom: spacing.md }]}>
        <View style={{ flex: 1 }}>
          <Text style={[adminStyles.label, { marginBottom: 0 }]}>Pause ordering</Text>
          <Text style={adminStyles.cardMeta}>Customers can browse but can’t place new orders.</Text>
        </View>
        <Switch
          value={form.maintenanceMode}
          onValueChange={(v) => setForm((f) => ({ ...f, maintenanceMode: v }))}
          trackColor={{ true: colors.playportOrange }}
        />
      </View>
      <View style={adminStyles.field}>
        <Text style={adminStyles.label}>Message shown to customers while paused</Text>
        <TextInput
          style={[adminStyles.input, { minHeight: 72, textAlignVertical: 'top' }]}
          value={form.maintenanceMessage}
          onChangeText={(t) => setForm((f) => ({ ...f, maintenanceMessage: t }))}
          multiline
          placeholderTextColor={colors.mutedText}
        />
      </View>
      <View style={[adminStyles.row, { marginBottom: spacing.md }]}>
        <Text style={[adminStyles.label, { marginBottom: 0, flex: 1 }]}>Allow guest checkout</Text>
        <Switch
          value={form.allowGuestCheckout}
          onValueChange={(v) => setForm((f) => ({ ...f, allowGuestCheckout: v }))}
          trackColor={{ true: colors.playportOrange }}
        />
      </View>

      {error ? <Text style={adminStyles.error}>{error}</Text> : null}
      {saved ? <Text style={adminStyles.cardMeta}>Saved.</Text> : null}
      <Button
        title={saving ? 'Saving…' : 'Save settings'}
        size="sm"
        disabled={saving}
        onPress={() => void onSave()}
      />
    </ScrollView>
  );
}
