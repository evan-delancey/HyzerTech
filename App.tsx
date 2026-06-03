import 'expo-dev-client';
import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { initDb } from './src/lib/db';
import { initPurchases } from './src/lib/subscription';
import { useSubscription } from './src/hooks/useSubscription';
import CameraScreen from './src/screens/CameraScreen';
import StatsScreen from './src/screens/StatsScreen';
import PaywallScreen from './src/screens/PaywallScreen';
import { colors } from './src/lib/theme';

const Tab = createBottomTabNavigator();

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons: Record<string, string> = { Camera: '📷', Stats: '📊' };
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{icons[name]}</Text>
    </View>
  );
}

function AppTabs() {
  const { hasAccess, loading } = useSubscription();

  if (loading) return null;

  if (!hasAccess) {
    return <PaywallScreen />;
  }

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgCard,
          borderTopColor: colors.grayDark,
        },
        tabBarActiveTintColor: colors.cyan,
        tabBarInactiveTintColor: colors.gray,
        tabBarLabelStyle: { fontSize: 11, letterSpacing: 1, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Camera"
        component={CameraScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="Camera" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Stats"
        component={StatsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="Stats" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  useEffect(() => {
    initDb();
    initPurchases();
  }, []);

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <AppTabs />
    </NavigationContainer>
  );
}
