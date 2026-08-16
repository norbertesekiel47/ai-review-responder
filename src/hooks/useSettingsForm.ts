'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardSettings } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  buildAccountSettingsPatch,
  countDirtyFields,
} from './settings-form-patch';

/** The light GET /api/settings payload — the only fields the settings pages
 *  read (previously satisfied by fetching the entire /api/dashboard). */
export interface SettingsPageData {
  business: { name: string; createdAt: string };
  settings: DashboardSettings;
}

/** GET /api/settings union: settings data, or a redirect-gate marker. */
type SettingsResponse = Partial<SettingsPageData> & {
  subscriptionStatus?: string;
  funnelUrl?: string | null;
};

export interface SettingsForm {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
  ownerPhone: string;
  weeklySummaryEnabled: boolean;
  monthlyImpactEnabled: boolean;
}

function settingsToForm(s: DashboardSettings): SettingsForm {
  return {
    tone: s.tone,
    productsServices: s.productsServices,
    avoidFacts: s.avoidFacts.slice(),
    sampleResponses: s.sampleResponses.slice(),
    ownerPhone: s.ownerPhone,
    weeklySummaryEnabled: s.weeklySummaryEnabled,
    monthlyImpactEnabled: s.monthlyImpactEnabled,
  };
}

export function settingsRedirectForDashboardData(
  json: { subscriptionStatus?: string; funnelUrl?: string | null },
): string | null {
  // The server's funnel entry point, not a hardcoded paywall URL. Absent →
  // /dashboard, whose own account-state screen carries the same next action.
  if (json.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) return json.funnelUrl ?? '/dashboard';
  if (json.subscriptionStatus === 'active_pending_business') {
    return '/dashboard';
  }
  return null;
}

export interface UseSettingsForm {
  data: SettingsPageData | null;
  form: SettingsForm | null;
  initial: SettingsForm | null;
  fetchError: string | null;
  saveError: string | null;
  saving: boolean;
  savedFlash: boolean;
  dirty: boolean;
  dirtyCount: number;
  set: <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => void;
  save: () => Promise<void>;
  discard: () => void;
}

export function useSettingsForm(): UseSettingsForm {
  const [data, setData] = useState<SettingsPageData | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [initial, setInitial] = useState<SettingsForm | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    // fallow-ignore-next-line complexity
    async function load() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json: SettingsResponse = await res.json();
        if (cancelled) return;
        const redirectUrl = settingsRedirectForDashboardData(json);
        if (redirectUrl) {
          window.location.href = redirectUrl;
          return;
        }
        if (!json.business || !json.settings) {
          throw new Error('Malformed settings response');
        }
        const page: SettingsPageData = { business: json.business, settings: json.settings };
        setData(page);
        const f = settingsToForm(page.settings);
        setForm(f);
        setInitial(f);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    return buildAccountSettingsPatch(initial, form) !== null;
  }, [form, initial]);

  const dirtyCount = useMemo(() => {
    if (!form || !initial) return 0;
    return countDirtyFields(initial, form);
  }, [form, initial]);

  function set<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  // fallow-ignore-next-line complexity
  async function save() {
    if (!form || !initial) return;
    const patch = buildAccountSettingsPatch(initial, form);
    if (!patch) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setInitial({ ...form });
      setSavedFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (initial) setForm({ ...initial });
  }

  return { data, form, initial, fetchError, saveError, saving, savedFlash, dirty, dirtyCount, set, save, discard };
}
