import { BusinessOsShell } from "@/components/BusinessOsShell";
import { ensureSeeded } from "@/db/seed";

export const dynamic = "force-dynamic";

export default async function AppPortalPage() {
  try {
    await ensureSeeded();
  } catch (err) {
    console.error("[APP_SEED_WARN]", err);
  }
  return <BusinessOsShell />;
}
