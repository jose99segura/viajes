import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Pages set only their own name; the suffix is applied here so a new page
  // cannot forget it.
  title: { default: "Viajes", template: "%s · Viajes" },
  applicationName: "Viajes",
  description: "Seguimiento de precios de vuelos LUX / SCN / HHN ⇄ ALC",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
