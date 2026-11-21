import { sourceName } from "../core/provenance.ts";
import { groupBySection, isUnannotated, SECTION_LABELS, type Section } from "../core/issue.ts";
import type { IssueItemView, IssueView } from "../store/issue.ts";
import {
  escapeHtml,
  unsubscribeFooterHtml,
  unsubscribeFooterText,
  type EmailContent,
} from "./email.ts";

export interface IssueEmailOptions {
  /** The recipient's own unsubscribe page. */
  unsubscribeLink: string;
  /** True only for the operator's read-through; the sent issue never carries the banner. */
  preview: boolean;
}

const PREVIEW_WARNING =
  "No included item has a note yet, so this issue would read as a changelog. Add a sentence to each item that matters before publishing.";

/**
 * Notes and the intro are plain text. A blank line starts a new paragraph and
 * a single newline stays a line break; nothing else is interpreted, so neither
 * Markdown nor HTML can pass through.
 */
const paragraphs = (value: string): string[] =>
  value
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

const paragraphsHtml = (value: string, attributes = ""): string[] =>
  paragraphs(value).map(
    (paragraph) => `<p${attributes}>${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`,
  );

/**
 * Only http and https provenance becomes a link. The digest email escapes a
 * URL and trusts its scheme; an issue is curated by hand and sent to everyone,
 * so a `javascript:` or `data:` URL that reached a stored row must never become
 * a clickable link. A rejected URL leaves the title as plain text.
 */
const safeHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Larger type for the lead, as an inline style because mail clients drop most `<style>` blocks. */
const sizeStyle = (section: Section): string =>
  section === "lead" ? ' style="font-size:1.25em"' : "";

const itemHtml = (item: IssueItemView, section: Section): string => {
  const first = item.event.provenance[0];
  const url = first ? safeHttpUrl(first.url) : null;
  const title = escapeHtml(item.event.title);
  const linked = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title;
  const name = first ? sourceName(first.url) : null;
  const source = name ? ` <span class="issue-source">— ${escapeHtml(name)}</span>` : "";
  return [
    '    <article class="issue-item">',
    // The note is the point of the issue, so it comes first, at full body size.
    ...paragraphsHtml(item.note ?? "", ` class="issue-note"${sizeStyle(section)}`).map(
      (line) => `      ${line}`,
    ),
    `      <p class="issue-event"${sizeStyle(section)}>${linked}${source}</p>`,
    "    </article>",
  ].join("\n");
};

const itemText = (item: IssueItemView): string => {
  const first = item.event.provenance[0];
  const url = first ? safeHttpUrl(first.url) : null;
  return [
    ...(paragraphs(item.note ?? "").length > 0
      ? [paragraphs(item.note ?? "").join("\n\n"), ""]
      : []),
    `- ${item.event.title}`,
    ...(url ? [`  ${url}`] : []),
    ...(first && sourceName(first.url) ? [`  Source: ${sourceName(first.url)}`] : []),
  ].join("\n");
};

/**
 * The weekly issue as an email: intro, then sections in editorial order, each
 * item led by the operator's note. Only included items render. The preview
 * adds a banner and a subject prefix when no included item has a note; the
 * published email never contains either.
 */
export const renderIssueEmail = (
  issue: Pick<IssueView, "number" | "title" | "intro">,
  allItems: IssueItemView[],
  { unsubscribeLink, preview }: IssueEmailOptions,
): EmailContent => {
  const items = allItems.filter((item) => item.included);
  const title = issue.title.trim();
  const heading =
    title === "" ? `Platform Pulse #${issue.number}` : `Platform Pulse #${issue.number}: ${title}`;
  const subject = preview ? `[Preview] ${heading}` : heading;
  const warn = preview && isUnannotated(items);
  const groups = groupBySection(items);

  const html = [
    ...(warn
      ? [
          `<p class="issue-preview-banner" role="note" style="border:2px solid #b45309;padding:0.75em"><strong>Preview.</strong> ${escapeHtml(PREVIEW_WARNING)}</p>`,
        ]
      : []),
    `<h1>${escapeHtml(heading)}</h1>`,
    ...paragraphsHtml(issue.intro).map((line) => `  ${line}`),
    ...groups.flatMap((group) => [
      `  <section class="issue-section issue-section-${group.section}">`,
      `    <h2>${escapeHtml(SECTION_LABELS[group.section])}</h2>`,
      ...group.items.map((item) => itemHtml(item, group.section)),
      "  </section>",
    ]),
    unsubscribeFooterHtml(unsubscribeLink),
  ].join("\n");

  const text = [
    ...(warn ? [`[Preview] ${PREVIEW_WARNING}`, ""] : []),
    heading,
    ...(paragraphs(issue.intro).length > 0 ? ["", paragraphs(issue.intro).join("\n\n")] : []),
    ...groups.flatMap((group) => [
      "",
      `# ${SECTION_LABELS[group.section]}`,
      "",
      group.items.map(itemText).join("\n\n"),
    ]),
    "",
    unsubscribeFooterText(unsubscribeLink),
  ].join("\n");

  return { subject, text, html };
};
