import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "primary" | "accent" | "danger";
  size?: "md" | "lg";
  children?: ReactNode;
};

export function IconButton({
  icon: Icon,
  label,
  tone = "default",
  size = "md",
  children,
  className,
  ...rest
}: Props) {
  const classes = ["icon-btn", `tone-${tone}`, `size-${size}`, className].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} title={label} aria-label={label} {...rest}>
      <Icon size={size === "lg" ? 18 : 16} strokeWidth={1.8} aria-hidden="true" />
      {children ? <span className="icon-btn-text">{children}</span> : null}
    </button>
  );
}
