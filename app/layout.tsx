import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Analisador de Artigo Científico",
  description:
    "Converte, verifica citações, revisa o português e avalia artigos científicos com agentes especializados.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
