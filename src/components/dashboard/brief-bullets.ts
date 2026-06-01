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
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''))
    .filter((bullet) => bullet.length > 0)
    .map((bullet) => {
      return {
        key: uniqueSiblingKey(seen, bullet),
        text: bullet,
      };
    });
}
