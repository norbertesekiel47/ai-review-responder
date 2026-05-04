'use client';

import { useEffect, useState } from 'react';

export interface ChecklistItem {
  label: string;
  done: boolean;
  subText?: string;
  href: string;
}

interface SetupChecklistClientProps {
  items: ChecklistItem[];
  /** Stable key used for localStorage dismissal — typically the businessId. */
  dismissKey: string;
}

/**
 * Visibility rule: render iff at least one item is incomplete OR
 * (all complete AND user has not yet dismissed). Dismiss is per-business
 * via localStorage so the panel reappears for a different signed-in user
 * on the same browser.
 */
export function SetupChecklistClient({ items, dismissKey }: SetupChecklistClientProps) {
  const allComplete = items.every((i) => i.done);
  const [dismissed, setDismissed] = useState(false);
  // Mounted gate avoids a hydration flash where the server-rendered checklist
  // briefly appears before localStorage is read.
  const [mounted, setMounted] = useState(false);

  const storageKey = `setup-checklist-dismissed:${dismissKey}`;

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(storageKey) === '1');
    } catch {
      // localStorage may be disabled (private mode); fall back to "not dismissed".
    }
    setMounted(true);
  }, [storageKey]);

  function handleDismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // ignore
    }
  }

  if (!mounted) return null;
  if (allComplete && dismissed) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Get fully set up</h2>
        {allComplete && (
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-gray-400 hover:text-gray-600"
            aria-label="Dismiss setup checklist"
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="flex items-center gap-3 p-3 rounded-md hover:bg-gray-50 transition-colors"
          >
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
              item.done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>
              {item.done ? '✓' : ''}
            </div>
            <div>
              <span className={`text-sm ${item.done ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                {item.label}
              </span>
              {item.subText && (
                <p className="text-xs text-gray-400">{item.subText}</p>
              )}
            </div>
          </a>
        ))}
      </div>
      {allComplete && (
        <p className="text-sm text-green-600 mt-4 text-center">You&apos;re all set!</p>
      )}
    </div>
  );
}
