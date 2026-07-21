"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import styles from "./docs.module.css";
import { docsIntro, docsSections, type DocSection } from "./docs-content";

function sectionMatches(section: DocSection, query: string): boolean {
  if (query === "") return true;
  const haystack = [
    section.title,
    section.eyebrow,
    ...section.intro,
    section.trust ?? "",
    ...section.links.flatMap((link) => [link.label, link.description, link.href]),
    ...(section.notes ?? []),
  ]
    .join(" ")
    .toLocaleLowerCase("en-US");
  return haystack.includes(query);
}

export function DocsBrowser() {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("en-US");

  const visibleSections = useMemo(
    () => docsSections.filter((section) => sectionMatches(section, normalized)),
    [normalized],
  );

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">{docsIntro.eyebrow}</p>
          <h1>{docsIntro.title}</h1>
          <p className="page-subtitle">{docsIntro.lede}</p>
        </div>
      </section>

      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="Documentation sections">
          <div className={styles.tocSearch}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the docs…"
              aria-label="Search documentation"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {visibleSections.map((section) => (
            <a className={styles.tocLink} href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
          {visibleSections.length === 0 ? (
            <p className={styles.tocLink}>No sections match.</p>
          ) : null}
        </nav>

        <div className={styles.content}>
          {visibleSections.map((section) => (
            <section className={`panel ${styles.section}`} id={section.id} key={section.id}>
              <p className="eyebrow">{section.eyebrow}</p>
              <h2>{section.title}</h2>
              <div className={styles.sectionIntro}>
                {section.intro.map((paragraph) => (
                  <p key={paragraph.slice(0, 40)}>{paragraph}</p>
                ))}
              </div>

              {section.trust ? (
                <div className="trust-strip" role="note">
                  <span className="trust-icon">i</span>
                  <span>{section.trust}</span>
                </div>
              ) : null}

              <div className={styles.linkGrid}>
                {section.links.map((link) => (
                  <Link className={styles.linkCard} href={link.href} key={link.href}>
                    <strong>
                      {link.label}
                      <span aria-hidden="true">{link.href}</span>
                    </strong>
                    <small>{link.description}</small>
                  </Link>
                ))}
              </div>

              {section.notes ? (
                <ul className={styles.notes}>
                  {section.notes.map((note) => (
                    <li key={note.slice(0, 40)}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}

          {visibleSections.length === 0 ? (
            <div className={`panel ${styles.empty}`}>
              <strong>No documentation matches &ldquo;{query}&rdquo;.</strong>
              <p>Try a shorter or different term.</p>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
