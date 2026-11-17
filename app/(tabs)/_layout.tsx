import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { Platform, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COMBOS_ENABLED } from '@/constants/features';
import { colors, fonts, layout, radii } from '@/constants/theme';
import { useResponsive } from '@/hooks/useResponsive';
type IconName = keyof typeof Ionicons.glyphMap;

function TabIcon({ name, color, focused }: { name: IconName; color: string; focused: boolean }) {
  const scale = useSharedValue(focused ? 1 : 0.92);

  useEffect(() => {
    scale.value = withSpring(focused ? 1 : 0.92, { damping: 14, stiffness: 260 });
  }, [focused, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const icon = (
    <Animated.View style={[styles.iconWrap, animatedStyle]}>
      <Ionicons name={name} size={focused ? 22 : 21} color={color} />
    </Animated.View>
  );

  if (!focused) return icon;

  return (
    <Animated.View style={styles.glowWrap}>
      <LinearGradient
        colors={['rgba(249,115,22,0.18)', 'rgba(249,115,22,0)']}
        style={styles.glowGradient}
        pointerEvents="none"
      />
      {icon}
    </Animated.View>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { contentWidth } = useResponsive();
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'web' ? 10 : 0);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.playportOrange,
        tabBarInactiveTintColor: colors.mutedText,
        tabBarStyle: [
          styles.tabBar,
          {
            height: layout.tabBarHeight + bottomInset,
            paddingBottom: bottomInset > 0 ? bottomInset : 10,
            width: '100%',
            maxWidth: contentWidth,
            alignSelf: 'center',
          },
          Platform.OS === 'web' && styles.tabBarWeb,
        ],
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: styles.item,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} color={String(color)} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="combos"
        options={
          COMBOS_ENABLED
            ? {
                title: 'Combos',
                tabBarIcon: ({ color, focused }) => (
                  <TabIcon
                    name={focused ? 'layers' : 'layers-outline'}
                    color={String(color)}
                    focused={focused}
                  />
                ),
              }
            : {
                href: null,
              }
        }
      />
      <Tabs.Screen
        name="experiences"
        options={{
          title: 'Experiences',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? 'sparkles' : 'sparkles-outline'}
              color={String(color)}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'receipt' : 'receipt-outline'} color={String(color)} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? 'person' : 'person-outline'}
              color={String(color)}
              focused={focused}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
        backgroundColor: colors.page,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: 8,
        ...Platform.select({
          web: {
            backgroundColor: colors.page,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            boxShadow: '0 -1px 0 rgba(0,0,0,0.04)',
          } as object,
          default: {},
        }),
  },
  tabBarWeb: {
    width: '100%',
  },
  label: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    marginTop: 2,
  },
  item: {
    flex: 1,
    flexBasis: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 28,
    borderRadius: radii.sm,
  },
  glowWrap: {
    width: 48,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.md,
  },
});
