import { readFlag } from '@/lib/config/flags';

export function judgeEnabled(): boolean {
  return readFlag('JUDGE_ENABLED');
}
