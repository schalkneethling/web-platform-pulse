import { Fragment } from "react";
import { groupByTheme, THEME_LABELS, type DigestView } from "../core/digest.ts";
import { splitBrowserSupport, type SupportRollup } from "../core/support-rollup.ts";
import type { ChangeEvent } from "../core/types.ts";

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long" });

const DigestItem = ({ item }: { item: ChangeEvent }) => (
  <li className="digest-item">
    <h4 className="digest-item__title">{item.title}</h4>
    {item.occurredAt !== null && (
      <p className="digest-item__date">
        Changed on <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
      </p>
    )}
    <ul className="digest-item__sources" aria-label="Sources">
      {item.provenance.map((source) => (
        <li key={source.url}>
          <a className="digest-item__source-link" href={source.url}>
            {new URL(source.url).host}
          </a>
        </li>
      ))}
    </ul>
  </li>
);

/** Rolled-up browser support reads as one sentence, features linked. */
const RollupItem = ({ rollup }: { rollup: SupportRollup }) => (
  <li className="digest-item">
    <p className="digest-item__prose">
      {rollup.lead}{" "}
      {rollup.features.map((feature, index) => (
        <Fragment key={feature.id}>
          {index > 0 && (index === rollup.features.length - 1 ? " and " : ", ")}
          <a className="digest-item__source-link" href={feature.url}>
            {feature.name}
          </a>
        </Fragment>
      ))}
      .
    </p>
  </li>
);

export const DigestArticle = ({ digest }: { digest: DigestView }) => (
  <article className="digest" aria-labelledby="digest-title">
    <header className="digest__header">
      <h2 className="digest__title" id="digest-title">
        Digest — {formatDate(digest.windowEnd)}
      </h2>
      <p className="digest__window">
        Covering <time dateTime={digest.windowStart}>{formatDate(digest.windowStart)}</time> to{" "}
        <time dateTime={digest.windowEnd}>{formatDate(digest.windowEnd)}</time>
      </p>
    </header>
    {groupByTheme(digest.items).map((group) => {
      const { rest, rollups } = splitBrowserSupport(group.items);
      return (
        <section
          key={group.theme}
          className="digest__theme"
          aria-labelledby={`theme-${group.theme}`}
        >
          <h3 className="digest__theme-title" id={`theme-${group.theme}`}>
            {THEME_LABELS[group.theme] ?? group.theme}
          </h3>
          <ol className="digest__items">
            {rest.map((item) => (
              <DigestItem key={item.id} item={item} />
            ))}
            {rollups.map((rollup) => (
              <RollupItem key={rollup.lead} rollup={rollup} />
            ))}
          </ol>
        </section>
      );
    })}
  </article>
);
