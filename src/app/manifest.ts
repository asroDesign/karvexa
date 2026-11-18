import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Karvexa",
    short_name: "Karvexa",
    description: "سامانه مدیریت کسب‌وکار، حسابداری و انبارداری کاروِکسا",
    lang: "fa",
    dir: "rtl",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f5f7f5",
    theme_color: "#047857",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/icons/karvexa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/karvexa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
