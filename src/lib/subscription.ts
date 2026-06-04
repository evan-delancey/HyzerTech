import Purchases, { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { Platform } from 'react-native';

// Replace these with your real RevenueCat keys from https://app.revenuecat.com
// Leave as-is during development — app will run in free trial mode automatically
const REVENUECAT_ANDROID_KEY = 'YOUR_REVENUECAT_ANDROID_KEY';
const REVENUECAT_IOS_KEY = 'YOUR_REVENUECAT_IOS_KEY';
const ENTITLEMENT_ID = 'pro';

const hasRealKeys =
  !REVENUECAT_ANDROID_KEY.startsWith('YOUR_') &&
  !REVENUECAT_IOS_KEY.startsWith('YOUR_');

export async function initPurchases() {
  if (!hasRealKeys) return; // skip until real keys are added
  const apiKey =
    Platform.OS === 'android' ? REVENUECAT_ANDROID_KEY : REVENUECAT_IOS_KEY;
  await Purchases.configure({ apiKey });
}

export async function getSubscriptionPackage(): Promise<PurchasesPackage | null> {
  if (!hasRealKeys) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.monthly ?? null;
  } catch {
    return null;
  }
}

export async function purchaseSubscription(
  pkg: PurchasesPackage
): Promise<boolean> {
  if (!hasRealKeys) return false;
  try {
    await Purchases.purchasePackage(pkg);
    return true;
  } catch {
    return false;
  }
}

export async function restorePurchases(): Promise<boolean> {
  if (!hasRealKeys) return false;
  try {
    const info = await Purchases.restorePurchases();
    return isProUser(info);
  } catch {
    return false;
  }
}

export async function checkSubscriptionStatus(): Promise<{
  isPro: boolean;
  isTrialing: boolean;
  trialDaysLeft: number;
}> {
  // No real keys yet — grant full access during development
  if (!hasRealKeys) {
    return { isPro: false, isTrialing: true, trialDaysLeft: 30 };
  }
  try {
    const info = await Purchases.getCustomerInfo();
    const entitlement = info.entitlements.active[ENTITLEMENT_ID];
    const isPro = !!entitlement;

    const firstSeen = new Date(info.firstSeen);
    const daysSinceFirstSeen =
      (Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24);
    const trialDaysLeft = Math.max(0, Math.ceil(30 - daysSinceFirstSeen));
    const isTrialing = trialDaysLeft > 0 && !isPro;

    return { isPro, isTrialing, trialDaysLeft };
  } catch {
    return { isPro: false, isTrialing: true, trialDaysLeft: 30 };
  }
}

function isProUser(info: CustomerInfo): boolean {
  return !!info.entitlements.active[ENTITLEMENT_ID];
}
