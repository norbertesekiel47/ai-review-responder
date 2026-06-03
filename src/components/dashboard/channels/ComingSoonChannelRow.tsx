export interface ComingSoonChannelRowProps {
  icon: string;
  name: string;
  reason: string;
}

export function ComingSoonChannelRow({ icon, name, reason }: ComingSoonChannelRowProps) {
  const iconClass = name === 'SMS' ? 'ch-sms' : name === 'WhatsApp' ? 'ch-wa' : 'ch-tg';
  return (
    <div className="channel-row coming-soon">
      <div className={`channel-icon ${iconClass}`} aria-hidden>{icon}</div>
      <div className="channel-meta">
        <div className="channel-name">{name}</div>
        <div className="channel-handle">{reason}</div>
      </div>
      <span className="channel-status cs-soon">Coming soon</span>
    </div>
  );
}
