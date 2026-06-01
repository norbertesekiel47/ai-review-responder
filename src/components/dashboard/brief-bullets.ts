export interface BriefBullet {
  key: string;
  text: string;
}

export function getBriefBullets(text: string): BriefBullet[] {
  const seen = new Map<string, number>();
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''))
    .map((bullet) => {
      const occurrence = seen.get(bullet) ?? 0;
      seen.set(bullet, occurrence + 1);
      return {
        key: occurrence === 0 ? bullet : `${bullet}-${occurrence}`,
        text: bullet,
      };
    });
}
