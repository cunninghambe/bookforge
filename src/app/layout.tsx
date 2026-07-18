import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CommandPalette } from "@/components/CommandPalette";
import "./globals.css";

// A9: a minimal book-glyph favicon inlined as a data URI, so it renders with no
// extra network request (and no middleware gate on a pre-auth page). A13
// recolors it to the terracotta accent to match the TopNav wordmark.
const BOOK_FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2032%2032'%3E%3Crect%20x%3D'7'%20y%3D'5'%20width%3D'18'%20height%3D'22'%20rx%3D'4'%20fill%3D'%23C15F3C'%2F%3E%3Crect%20x%3D'7'%20y%3D'5'%20width%3D'4'%20height%3D'22'%20rx%3D'2'%20fill%3D'%23A64E2E'%2F%3E%3Cpath%20d%3D'M14%2012h9M14%2016h9M14%2020h6'%20stroke%3D'%23FAF9F5'%20stroke-width%3D'1.6'%20stroke-linecap%3D'round'%2F%3E%3C%2Fsvg%3E";

export const metadata: Metadata = {
  title: "bookforge",
  description: "AI-drafted, human-steered novel writing tool",
  icons: { icon: BOOK_FAVICON },
};

// A9 theme mechanics: the theme is stored in a long-lived plain cookie
// (bookforge_theme). The root layout reads it server-side and stamps the dark
// class on <html> at render, so there is never a flash of the wrong theme. The
// cookie is readable pre-auth, so /login is themed too.
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = (await cookies()).get("bookforge_theme")?.value;
  const isDark = theme === "dark";
  return (
    <html lang="en" className={isDark ? "dark" : undefined}>
      <body className="font-sans antialiased">
        <div className="mx-auto max-w-5xl px-6">{children}</div>
        {/* A11: the command palette overlay (Ctrl/Cmd+K), one instance app-wide. */}
        <CommandPalette />
      </body>
    </html>
  );
}
