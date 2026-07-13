export function formatIdentifier(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "Reply auto posted" reads like three events; the hyphen keeps it one.
const OUTCOME_KIND_LABELS: Record<string, string> = {
  reply_auto_posted: 'Reply auto-posted',
};

export function formatOutcomeKind(outcomeKind: string): string {
  return OUTCOME_KIND_LABELS[outcomeKind] ?? formatIdentifier(outcomeKind);
}

const DEADLINE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

const DEADLINE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Viewer-local deadline: hour+minute, with month/day added when not today. */
export function formatDeadline(value: string | number, now: Date): string {
  const deadline = new Date(value);
  const isToday = deadline.getFullYear() === now.getFullYear()
    && deadline.getMonth() === now.getMonth()
    && deadline.getDate() === now.getDate();
  return (isToday ? DEADLINE_TIME_FORMATTER : DEADLINE_DATE_TIME_FORMATTER).format(deadline);
}
