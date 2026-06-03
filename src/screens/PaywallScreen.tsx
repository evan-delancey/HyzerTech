import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { PurchasesPackage } from 'react-native-purchases';
import { colors } from '../lib/theme';
import {
  getSubscriptionPackage,
  purchaseSubscription,
  restorePurchases,
} from '../lib/subscription';

export default function PaywallScreen() {
  const [pkg, setPkg] = useState<PurchasesPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);

  useEffect(() => {
    getSubscriptionPackage().then((p) => {
      setPkg(p);
      setLoading(false);
    });
  }, []);

  const handlePurchase = async () => {
    if (!pkg) return;
    setPurchasing(true);
    const success = await purchaseSubscription(pkg);
    setPurchasing(false);
    if (!success) {
      Alert.alert('Purchase Failed', 'Please try again or restore purchases.');
    }
  };

  const handleRestore = async () => {
    setLoading(true);
    const restored = await restorePurchases();
    setLoading(false);
    if (restored) {
      Alert.alert('Restored', 'Your subscription has been restored.');
    } else {
      Alert.alert('Not Found', 'No active subscription found for this account.');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>
        HYZER<Text style={{ color: colors.cyan }}>TECH</Text>
      </Text>

      <Text style={styles.headline}>Unlock HyzerTech Pro</Text>
      <Text style={styles.sub}>
        Your free month is over. Keep measuring your throws.
      </Text>

      <View style={styles.featureList}>
        {[
          'Unlimited throw measurements',
          'Speed & spin on every disc',
          'Voice readout after each throw',
          'Full stats history',
        ].map((f) => (
          <View key={f} style={styles.featureRow}>
            <Text style={styles.check}>✓</Text>
            <Text style={styles.featureText}>{f}</Text>
          </View>
        ))}
      </View>

      <View style={styles.priceBox}>
        <Text style={styles.price}>$5.00</Text>
        <Text style={styles.pricePer}>/ month</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 32 }} />
      ) : (
        <>
          <TouchableOpacity
            style={styles.buyBtn}
            onPress={handlePurchase}
            disabled={purchasing}
          >
            {purchasing ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.buyBtnText}>SUBSCRIBE NOW</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.restoreBtn} onPress={handleRestore}>
            <Text style={styles.restoreBtnText}>Restore Purchases</Text>
          </TouchableOpacity>
        </>
      )}

      <Text style={styles.legal}>
        Billed monthly. Cancel anytime in your device's subscription settings.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 60,
    paddingBottom: 40,
  },
  logo: {
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 4,
    color: colors.white,
    marginBottom: 32,
  },
  headline: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.white,
    textAlign: 'center',
    marginBottom: 10,
  },
  sub: {
    fontSize: 15,
    color: colors.gray,
    textAlign: 'center',
    marginBottom: 36,
    lineHeight: 22,
  },
  featureList: { width: '100%', marginBottom: 36 },
  featureRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  check: { color: colors.cyan, fontSize: 18, marginRight: 12, fontWeight: '700' },
  featureText: { color: colors.white, fontSize: 16 },
  priceBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 32,
  },
  price: { fontSize: 52, fontWeight: '900', color: colors.cyanLight },
  pricePer: { fontSize: 20, color: colors.gray, marginBottom: 8, marginLeft: 4 },
  buyBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 50,
    paddingHorizontal: 60,
    paddingVertical: 18,
    width: '100%',
    alignItems: 'center',
    marginBottom: 16,
  },
  buyBtnText: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 3,
  },
  restoreBtn: { marginBottom: 24 },
  restoreBtnText: { color: colors.gray, fontSize: 14, textDecorationLine: 'underline' },
  legal: { color: colors.gray, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
