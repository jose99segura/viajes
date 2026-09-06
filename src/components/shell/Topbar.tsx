import { ChatToggle } from "@/components/chat/ChatToggle";
import { ThemeMenu } from "./ThemeMenu";

/** Sticky page header: title, the snapshot age, theme menu, chat toggle. */
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
      <ChatToggle />
    </div>
  );
}
