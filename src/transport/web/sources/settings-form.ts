import type { SubscriptionSettings } from '../../../shared/subscriptions/subscription-types.js';

export type SettingsForm = {
  subscriptionId: string;
  sent: SubscriptionSettings;
  shown: SubscriptionSettings;
};

export function openSettingsForm(subscriptionId: string, settings: SubscriptionSettings): SettingsForm {
  return { subscriptionId, sent: settings, shown: settings };
}

export function editSettingsForm(form: SettingsForm, patch: Partial<SubscriptionSettings>): SettingsForm {
  return { ...form, shown: { ...form.shown, ...patch } as SubscriptionSettings };
}

export function takeUnsent(form: SettingsForm): { form: SettingsForm; patch: Partial<SubscriptionSettings> } {
  const patch = Object.fromEntries(Object.entries(form.shown).filter(([key, value]) => value !== form.sent[key])) as Partial<SubscriptionSettings>;
  return { form: { ...form, sent: form.shown }, patch };
}
