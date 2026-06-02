import Link from 'next/link';
import { Icon } from './Icon';

export function HistoricalUpgradeBanner() {
  return (
    <div className="pr-upgrade">
      <div className="pr-upgrade-icon">
        <Icon name="lightbulb" size={18} />
      </div>
      <div className="pr-upgrade-text">
        <div className="pr-upgrade-title">Edit replies from before you joined</div>
        <div className="pr-upgrade-sub">
          Premium owners will be able to rewrite historical replies in your current tone, perfect for tightening up older
          one-liners. Currently view-only.
        </div>
      </div>
      <Link href="/onboarding/pay" className="pr-upgrade-cta">
        Upgrade →
      </Link>
    </div>
  );
}
