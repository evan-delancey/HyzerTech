import { useEffect, useState } from 'react';
import { checkSubscriptionStatus } from '../lib/subscription';

interface SubscriptionState {
  isPro: boolean;
  isTrialing: boolean;
  trialDaysLeft: number;
  hasAccess: boolean;
  loading: boolean;
}

export function useSubscription(): SubscriptionState {
  const [state, setState] = useState<SubscriptionState>({
    isPro: false,
    isTrialing: false,
    trialDaysLeft: 0,
    hasAccess: false,
    loading: true,
  });

  useEffect(() => {
    checkSubscriptionStatus().then(({ isPro, isTrialing, trialDaysLeft }) => {
      setState({
        isPro,
        isTrialing,
        trialDaysLeft,
        hasAccess: isPro || isTrialing,
        loading: false,
      });
    });
  }, []);

  return state;
}
