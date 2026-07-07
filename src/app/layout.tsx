import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "bookforge",
  description: "AI-drafted, human-steered novel writing tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <div className="mx-auto max-w-5xl px-6">{children}</div>
      </body>
    </html>
  );
}
