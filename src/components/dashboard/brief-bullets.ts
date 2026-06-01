import { uniqueSiblingKey } from '@/lib/shared/unique-sibling-key';

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
      return {
        key: uniqueSiblingKey(seen, bullet),
        text: bullet,
      };
    });
}
