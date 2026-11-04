export type Tone = "ok" | "warn" | "danger" | "idle" | "info" | "rec";

type Props = {
  tone: Tone;
  label: string;
  pulse?: boolean;
  announce?: boolean;
};

export function StatusChip({ tone, label, pulse = false, announce = false }: Props) {
  return (
    <span className={`chip tone-${tone}`} role={announce ? "status" : undefined}>
      <span className={pulse ? "chip-dot is-pulse" : "chip-dot"} aria-hidden="true" />
      <span className="chip-label">{label}</span>
    </span>
  );
}
