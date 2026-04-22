'use client';

import { useEffect, useState, useCallback } from 'react';
import type { DashboardData, DashboardSettings } from '@/app/api/dashboard/route';

type SettingsForm = {
  tone: string;
  productsServices: string;
  avoidFacts: string;
  sampleResponses: string;
  ownerPhone: string;
  weeklySummaryEnabled: boolean;
  monthlyImpactEnabled: boolean;
};

function settingsToForm(s: DashboardSettings): SettingsForm {
  return {
    tone: s.tone,
    productsServices: s.productsServices,
    avoidFacts: s.avoidFacts.join('\n'),
    sampleResponses: s.sampleResponses.join('\n'),
    ownerPhone: s.ownerPhone,
    weeklySummaryEnabled: s.weeklySummaryEnabled,
    monthlyImpactEnabled: s.monthlyImpactEnabled,
  };
}

function buildPatch(initial: SettingsForm, current: SettingsForm): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  if (current.tone !== initial.tone) patch.tone = current.tone;
  if (current.productsServices !== initial.productsServices) patch.productsServices = current.productsServices || null;
  if (current.avoidFacts !== initial.avoidFacts) {
    patch.avoidFacts = current.avoidFacts.trim() ? current.avoidFacts.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }
  if (current.sampleResponses !== initial.sampleResponses) {
    patch.sampleResponses = current.sampleResponses.trim() ? current.sampleResponses.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }
  if (current.ownerPhone !== initial.ownerPhone) patch.ownerPhone = current.ownerPhone || null;
  if (current.weeklySummaryEnabled !== initial.weeklySummaryEnabled) patch.weeklySummaryEnabled = current.weeklySummaryEnabled;
  if (current.monthlyImpactEnabled !== initial.monthlyImpactEnabled) patch.monthlyImpactEnabled = current.monthlyImpactEnabled;

  return Object.keys(patch).length > 0 ? patch : null;
}

export default function SettingsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [form, setForm] = useState<SettingsForm | null>(null);
  const [initialForm, setInitialForm] = useState<SettingsForm | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    async function fetchDashboard() {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json: DashboardData = await res.json();
        setData(json);
        const formData = settingsToForm(json.settings);
        setForm(formData);
        setInitialForm(formData);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    }
    fetchDashboard();
  }, []);

  const updateField = useCallback(<K extends keyof SettingsForm>(field: K, value: SettingsForm[K]) => {
    setForm((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  async function handleSave() {
    if (!form || !initialForm) return;

    const patch = buildPatch(initialForm, form);
    if (!patch) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

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

      setInitialForm({ ...form });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  if (fetchError) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-lg border border-red-300 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Error</h2>
          <p className="mt-1 text-sm text-red-700">{fetchError}</p>
        </div>
      </div>
    );
  }

  if (!data || !form) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading settings...</p>
      </div>
    );
  }

  const hasChanges = initialForm && buildPatch(initialForm, form) !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Success banner */}
      {saveSuccess && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">Settings saved</p>
        </div>
      )}

      {/* Section A: Business Profile */}
      <div className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Business Profile</h2>

        {/* Read-only fields */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Business Name</label>
          <input
            type="text"
            value={data.business.name}
            disabled
            className="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-500"
          />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Category</label>
          <input
            type="text"
            value={data.settings.category}
            disabled
            className="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-500"
          />
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Google Place ID</label>
          <input
            type="text"
            value={data.settings.googlePlaceId}
            disabled
            className="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-500"
          />
        </div>

        {/* Editable fields */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Response Tone</label>
          <textarea
            value={form.tone}
            onChange={(e) => updateField('tone', e.target.value)}
            maxLength={100}
            rows={2}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. professional and friendly"
          />
          <p className="mt-1 text-xs text-gray-400">{form.tone.length}/100</p>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Products &amp; Services</label>
          <textarea
            value={form.productsServices}
            onChange={(e) => updateField('productsServices', e.target.value)}
            maxLength={2000}
            rows={3}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Describe what your business offers"
          />
          <p className="mt-1 text-xs text-gray-400">{form.productsServices.length}/2000</p>
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Facts to Avoid</label>
          <textarea
            value={form.avoidFacts}
            onChange={(e) => updateField('avoidFacts', e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="One per line"
          />
          <p className="mt-1 text-xs text-gray-400">One per line. The AI will avoid mentioning these in responses.</p>
        </div>
        <div className="mb-0">
          <label className="block text-sm font-medium text-gray-700">Sample Responses</label>
          <textarea
            value={form.sampleResponses}
            onChange={(e) => updateField('sampleResponses', e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="One per line"
          />
          <p className="mt-1 text-xs text-gray-400">One per line. Example responses to guide the AI response style.</p>
        </div>
      </div>

      {/* Section B: Notification Preferences */}
      <div className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Notification Preferences</h2>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Phone Number</label>
          <input
            type="tel"
            value={form.ownerPhone}
            onChange={(e) => updateField('ownerPhone', e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="+1 (555) 123-4567"
          />
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700">Email</label>
          <input
            type="email"
            value={data.settings.ownerEmail}
            disabled
            className="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-500"
          />
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.weeklySummaryEnabled}
              onChange={(e) => updateField('weeklySummaryEnabled', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Weekly summary report
          </label>
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.monthlyImpactEnabled}
              onChange={(e) => updateField('monthlyImpactEnabled', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Monthly impact report
          </label>
        </div>
      </div>

      {/* Section C: Save */}
      <div>
        {saveError && (
          <p className="mb-3 text-sm text-red-600">{saveError}</p>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="w-full rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
