import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { Button } from '@/components/ui/Button';
import { colors, fonts, radii, spacing, typeScale } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
import { useAppStore } from '@/store/appStore';
import { resolveAuthNext } from '@/utils/authGate';
import { onboardingRoute } from '@/utils/onboarding';

export default function OtpScreen() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const returnTo = resolveAuthNext(next);
  const { horizontalPadding, formMaxWidth, isXs } = useResponsive();
  const phoneDraft = useAppStore((s) => s.phoneDraft);
  const otpMode = useAppStore((s) => s.otpMode);
  const login = useAppStore((s) => s.login);
  const requestOtp = useAppStore((s) => s.requestOtp);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(0);
  const [seconds, setSeconds] = useState(30);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<(TextInput | null)[]>([]);

  const phoneDisplay = phoneDraft
    ? `+91 ${phoneDraft.replace(/\D/g, '').slice(-10)}`
    : '+91 ••••••••••';

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const code = otp.join('');
  const canVerify = code.length === 6 && !verifying;
  const columnMax = formMaxWidth ?? 440;

  const updateDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    const nextDigits = [...otp];
    nextDigits[index] = digit;
    setOtp(nextDigits);
    if (digit && index < 5) {
      inputs.current[index + 1]?.focus();
    }
  };

  const onKeyPress = (index: number, key: string) => {
    if (key === 'Backspace' && !otp[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  const onVerify = async () => {
    setVerifying(true);
    setError(null);
    try {
      await login(code);
      const { user, addresses } = useAppStore.getState();
      const route = onboardingRoute(user, addresses);
      if (route === 'name') {
        router.replace({
          pathname: '/(auth)/onboarding',
          params: { next: returnTo },
        } as never);
      } else if (route === 'address') {
        router.replace({
          pathname: '/address/add',
          params: { onboarding: '1', next: returnTo },
        } as never);
      } else {
        router.replace(returnTo as never);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Invalid OTP';
      // Keep the real cause in the console: the friendly copy below is deliberately
      // vague, and a swallowed Firestore data error is impossible to diagnose from it.
      console.warn('OTP verify failed:', e);
      const friendly =
        /unsupported field value|undefined|setDoc/i.test(raw)
          ? 'Couldn’t finish sign-in. Please try again.'
          : /invalid|code|otp|credential/i.test(raw)
            ? 'That code doesn’t look right. Try again.'
            : raw;
      setError(friendly);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[
            styles.wrap,
            {
              paddingHorizontal: horizontalPadding,
              maxWidth: columnMax,
              alignSelf: 'center',
              width: '100%',
            },
          ]}
        >
          <View style={styles.topRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => router.back()}
              style={styles.back}
            >
              <Ionicons name="arrow-back" size={20} color={colors.secondaryText} />
            </Pressable>
            <BrandLogo size="md" />
            <View style={styles.backSpacer} />
          </View>

          <View style={styles.hero}>
            <Text style={styles.eyebrow}>Verification</Text>
            <Text style={styles.title}>Enter OTP</Text>
            <Text style={styles.subtitle}>
              We sent a 6-digit code to{'\n'}
              <Text style={styles.phone}>{phoneDisplay}</Text>
            </Text>
          </View>

          <View style={[styles.otpRow, isXs && styles.otpRowXs]}>
            {otp.map((digit, index) => {
              const active = focusedIndex === index || !!digit;
              return (
                <TextInput
                  key={index}
                  ref={(ref) => {
                    inputs.current[index] = ref;
                  }}
                  value={digit}
                  onChangeText={(v) => updateDigit(index, v)}
                  onKeyPress={({ nativeEvent }) => onKeyPress(index, nativeEvent.key)}
                  onFocus={() => setFocusedIndex(index)}
                  onBlur={() => setFocusedIndex((prev) => (prev === index ? null : prev))}
                  keyboardType="number-pad"
                  maxLength={1}
                  selectTextOnFocus
                  style={[
                    styles.otpBox,
                    isXs && styles.otpBoxXs,
                    active ? styles.otpBoxActive : null,
                  ]}
                  accessibilityLabel={`OTP digit ${index + 1}`}
                />
              );
            })}
          </View>

          <Button
            title={verifying ? 'Verifying…' : 'Verify & continue'}
            fullWidth
            size="lg"
            disabled={!canVerify}
            onPress={() => void onVerify()}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.footerLinks}>
            {seconds > 0 ? (
              <Text style={styles.resendMuted}>Resend code in {seconds}s</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setSeconds(30);
                  setOtp(['', '', '', '', '', '']);
                  inputs.current[0]?.focus();
                  void requestOtp(phoneDraft);
                }}
              >
                <Text style={styles.resendLink}>Resend OTP</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" onPress={() => router.replace('/(auth)/login')}>
              <Text style={styles.changeNumber}>Change number</Text>
            </Pressable>
          </View>

          {otpMode === 'mock' ? (
            <Text style={styles.hint}>Dev mode: enter any 6 digits to continue.</Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.page },
  flex: { flex: 1 },
  wrap: { flex: 1, paddingTop: spacing.md, gap: spacing.xxl },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  backSpacer: { width: 40, height: 40 },
  hero: { gap: spacing.sm },
  eyebrow: {
    color: colors.playportOrange,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 32,
    letterSpacing: -0.6,
  },
  subtitle: {
    color: colors.secondaryText,
    fontFamily: fonts.body,
    fontSize: typeScale.bodyLg,
    lineHeight: 22,
  },
  phone: { color: colors.primaryText, fontFamily: fonts.bodyMedium },
  otpRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    width: '100%',
  },
  otpRowXs: { gap: 6 },
  otpBox: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    aspectRatio: 1,
    maxWidth: 56,
    minWidth: 40,
    minHeight: 48,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontFamily: fonts.heading,
    fontSize: 22,
    textAlign: 'center',
    outlineStyle: 'none' as unknown as undefined,
  },
  otpBoxXs: {
    maxWidth: 46,
    minHeight: 44,
    fontSize: 18,
  },
  otpBoxActive: {
    borderColor: colors.playportOrange,
    backgroundColor: colors.orangeTint,
  },
  footerLinks: {
    alignItems: 'center',
    gap: spacing.md,
  },
  resendMuted: { color: colors.mutedText, fontFamily: fonts.body, fontSize: typeScale.body },
  resendLink: { color: colors.playportOrange, fontFamily: fonts.bodyMedium, fontSize: typeScale.bodyLg },
  changeNumber: {
    color: colors.secondaryText,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.body,
  },
  hint: {
    color: colors.mutedText,
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    textAlign: 'center',
    marginTop: 'auto',
    marginBottom: spacing.xl,
  },
  error: {
    color: colors.badgeRed,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    textAlign: 'center',
    marginTop: -spacing.md,
  },
});
