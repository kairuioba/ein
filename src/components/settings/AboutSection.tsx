// Settings → About: what this app is, who makes it, and where its releases
// live. The version is the one this build was made from: package.json is also
// where the desktop shell's app.getVersion() comes from, so the page and the
// native About panel always agree. The open-source license is the last, quiet
// row: Ein includes code from the Apache-2.0 OpenMausBot project, and that
// license and its NOTICE ship inside the app (Resources/licenses).
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { version } from "../../../package.json";
import { Card } from "@/components/SettingsPrimitives";
import { PRODUCT_FULL_NAME, PRODUCT_TAGLINE } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { SectionHeader, SettingRow } from "./parts";

export const APP_VERSION: string = version;

const AUTHOR = "kairuioba";
const AUTHOR_URL = "https://github.com/kairuioba";
// The source repository is private; installers and updates are public here.
const RELEASES_URL = "https://github.com/kairuioba/ein-releases";

/** A link that leaves the app. The desktop window hands target=_blank links
 * to the default browser (setWindowOpenHandler → shell.openExternal). */
function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-text hover:underline"
    >
      {children}
      <ExternalLink size={12} className="shrink-0" aria-hidden />
    </a>
  );
}

const withoutScheme = (url: string) => url.replace(/^https:\/\//, "");

export function AboutSection() {
  return (
    <>
      <SectionHeader title={t("About")} description={t("The app, who makes it, and where to get it.")} />
      <div className="flex flex-col gap-3.5">
        <Card className="pb-1.5">
          <div className="flex items-center gap-4 pb-4">
            <img src="/app-icon.svg" alt="" width={64} height={64} draggable={false} className="size-16 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-[20px] leading-tight font-bold tracking-[-0.2px] text-ink">{PRODUCT_FULL_NAME}</h2>
              <p className="mt-1 text-[13px] tracking-[0.05em] text-ink-secondary">{PRODUCT_TAGLINE}</p>
              <p className="mt-1.5 text-[12px] tabular-nums text-ink-secondary/80">{t("Version {version}", { version: APP_VERSION })}</p>
            </div>
          </div>
          <div className="border-t border-hairline/30">
            <SettingRow label={t("Author")}>
              <OutLink href={AUTHOR_URL}>{AUTHOR}</OutLink>
            </SettingRow>
            <SettingRow label={t("Downloads and updates")}>
              <OutLink href={RELEASES_URL}>{withoutScheme(RELEASES_URL)}</OutLink>
            </SettingRow>
            <SettingRow label={t("Open-source license")} sub={t("Includes code from the OpenMausBot project")}>
              <span className="text-ink-secondary">Apache-2.0</span>
            </SettingRow>
          </div>
        </Card>
      </div>
    </>
  );
}
