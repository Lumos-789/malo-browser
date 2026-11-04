import type { ReactNode } from "react";

type Props = {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
};

export function Panel({ title, meta, children, className, bodyClassName }: Props) {
  return (
    <section className={className ? `panel ${className}` : "panel"}>
      <header className="panel-head">
        <h2>{title}</h2>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      <div className={bodyClassName ? `panel-body ${bodyClassName}` : "panel-body"}>{children}</div>
    </section>
  );
}
