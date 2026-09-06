import { ThemeMenu } from "./ThemeMenu";

/**
 * Sticky page header: title, the snapshot age, the theme menu. The chat
 * toggle joins it when the chat panel is ported.
 */
export function Topbar({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <h1>{title}</h1>
      {meta && <span className="meta">{meta}</span>}
      <div className="grow" />
      {children}
      <ThemeMenu />
    </div>
  );
}
