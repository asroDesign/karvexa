import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Vazirmatn } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PwaRegistration } from "@/components/PwaRegistration";
import "./globals.css";

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-vazirmatn",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Business OS — سامانه جامع حسابداری، انبارداری و مدیریت پلتفرم",
  description:
    "پلتفرم Business OS با طراحی Glassmorphism، تایپوگرافی آسروتراول، داشبورد مالی روزانه، مدیریت دسترسی و چرخه کامل سال مالی",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable} suppressHydrationWarning>
      <body className="min-h-screen bos-canvas font-sans antialiased selection:bg-violet-500/20 selection:text-violet-900 dark:selection:text-violet-100">
        <ThemeProvider>
          <PwaRegistration />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
