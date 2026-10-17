// Settings → About: what this app is, who makes it, and the open-source
// project it is built on. The version is the one this build was made from:
// package.json is also where the desktop shell's app.getVersion() comes from,
// so the page and the native About panel always agree.
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
const REPOSITORY_URL = "https://github.com/kairuioba/ein";
const UPSTREAM_URL = "https://github.com/CuriosityOS/OpenMausBot";

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
      <SectionHeader title={t("About")} description={t("The app, who makes it, and the open-source project it builds on.")} />
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
            <SettingRow label={t("Source code")}>
              <OutLink href={REPOSITORY_URL}>{withoutScheme(REPOSITORY_URL)}</OutLink>
            </SettingRow>
          </div>
        </Card>
        <Card title={t("Open source")} subtitle={t("Based on the open-source OpenMausBot by CuriosityOS (Apache-2.0)")}>
          <OutLink href={UPSTREAM_URL}>{withoutScheme(UPSTREAM_URL)}</OutLink>
        </Card>
      </div>
    </>
  );
}
