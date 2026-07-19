import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { NotificationSettingsBrowser } from "./notification-settings-browser";

export const metadata: Metadata = { title: "Notification destinations" };

export default function NotificationSettingsPage() {
  return (
    <AppShell active="notification_settings">
      <NotificationSettingsBrowser />
    </AppShell>
  );
}
