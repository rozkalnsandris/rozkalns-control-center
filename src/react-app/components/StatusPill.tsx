interface StatusPillProps {
  label: string;
  tone: "good" | "warning" | "danger" | "info" | "neutral";
}

export function StatusPill({ label, tone }: StatusPillProps) {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}
