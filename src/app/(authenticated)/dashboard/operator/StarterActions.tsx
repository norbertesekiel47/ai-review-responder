'use client';

import { STARTER_ACTIONS } from './wording';
import './operator.css';

export interface StarterActionsProps {
  onPick: (message: string) => void;
  disabled: boolean;
}

/**
 * The three fixed starter messages (spec §3.1). Each POSTS its message rather
 * than filling the composer: the value of a starter is that the owner does not
 * have to decide how to phrase it, and a pre-filled box hands the decision
 * straight back.
 */
export function StarterActions({ onPick, disabled }: StarterActionsProps) {
  return (
    <div className="op-starters">
      {STARTER_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn btn-secondary op-action"
          disabled={disabled}
          onClick={() => onPick(action.message)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
