import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adedonha/Stop!",
  description: "Mesa de adedonha com letra, cronometro, respostas e placar.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
