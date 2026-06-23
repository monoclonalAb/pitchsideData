import { DateTime } from "luxon";
import { FLAG_BUDGET } from "./json.js";

/* Shared formatting helpers for the Markdown and console renderers, so both
 * present the same numbers the same way. */

// "2026-06-20T22:00:00Z" rendered in the venue zone as "Sat 6:00 PM EDT".
export function localLabel(utc, zone) {
  if (!utc || !zone) return null;
  const dt = DateTime.fromISO(utc, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt.toFormat("ccc h:mm a ZZZZ") : null;
}

// Signed, human delta: +2h00, -30m, or 0.
export function deltaLabel(minutes) {
  if (minutes == null) return "-";
  if (minutes === 0) return "0";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h ? `${sign}${h}h${String(m).padStart(2, "0")}` : `${sign}${m}m`;
}

export function summaryLine(summary) {
  return [
    `${summary.change_recommended} change-rec`,
    `${summary.review} review`,
    `${summary.postponed_or_cancelled} postponed`,
    `${summary.confirmed} confirmed`,
    `${summary.monitor} monitor`,
    `${summary.insufficient_evidence} insufficient`,
    `${summary.could_not_assess} unavailable`,
  ].join(" · ");
}

export function budgetBanner(summary) {
  return summary.over_budget
    ? `[!] ${summary.actionable} actionable flags exceed the ~${FLAG_BUDGET}/day budget - ranked below, none hidden.`
    : null;
}
