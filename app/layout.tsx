import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./inventory-v2.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Satmi Inventory",
  description: "Physical stock, product recipes and packaging rules for Satmi.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeBootstrap = `(function(){try{document.documentElement.dataset.theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}catch(e){}})();`;
  return <html lang="en" suppressHydrationWarning><body className={`${geistSans.variable} ${geistMono.variable}`}><script dangerouslySetInnerHTML={{ __html: themeBootstrap }}/>{children}</body></html>;
}
