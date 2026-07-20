"use client";

import { useState } from "react";

/* ================================================================== *
 * Real contact form for the public marketing site. Client component so
 * it can POST to /api/contact and reflect submit state — no mail-client
 * link, no placeholder address. HONESTY: on success we say only that we have
 * "received" the details, because the endpoint's guarantee is durable
 * persistence; whether it was also emailed depends on the delivery
 * transport configured server-side.
 * ================================================================== */

// Mirrors the server-side format check closely enough to give instant
// feedback; the server remains the authority.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;

type Status = "idle" | "submitting" | "success" | "error";

function Arrow() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export default function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — must stay empty
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");

  const canSubmit =
    status !== "submitting" &&
    name.trim().length > 0 &&
    EMAIL.test(email.trim()) &&
    message.trim().length > 0;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus("submitting");
    setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company: company.trim(),
          message: message.trim(),
          website, // honeypot: real users leave this blank
        }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (response.ok && payload?.ok === true) {
        setStatus("success");
        return;
      }
      throw new Error("request failed");
    } catch {
      setStatus("error");
      setError("Something went wrong sending your message. Please try again in a moment.");
    }
  }

  if (status === "success") {
    return (
      <div className="lx-contact-card lx-form-done" role="status" aria-live="polite">
        <span className="lx-contact-tag">message received</span>
        <h2>Thanks — we&rsquo;ve received your details.</h2>
        <p>
          Your message is safely recorded and a member of the Sutra team will be in touch. If
          anything is time-sensitive, feel free to send another note with more detail.
        </p>
      </div>
    );
  }

  return (
    <form className="lx-contact-card lx-form" onSubmit={onSubmit} noValidate aria-label="Contact the Sutra team">
      <span className="lx-contact-tag">send a message</span>
      <h2>Tell us what you&rsquo;re running</h2>
      <p>AWS accounts, EKS clusters, the questions you have — a couple of lines is plenty to get a walkthrough set up.</p>

      <div className="lx-field">
        <label htmlFor="cf-name">Name<span aria-hidden="true"> *</span></label>
        <input
          id="cf-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="lx-field">
        <label htmlFor="cf-email">Work email<span aria-hidden="true"> *</span></label>
        <input
          id="cf-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="lx-field">
        <label htmlFor="cf-company">Company <em>(optional)</em></label>
        <input
          id="cf-company"
          name="company"
          type="text"
          autoComplete="organization"
          maxLength={200}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <div className="lx-field">
        <label htmlFor="cf-message">Message<span aria-hidden="true"> *</span></label>
        <textarea
          id="cf-message"
          name="message"
          required
          rows={5}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {/* Honeypot: hidden from users and assistive tech; only bots fill it. */}
      <div className="lx-honeypot" aria-hidden="true">
        <label htmlFor="cf-website">Website</label>
        <input
          id="cf-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {status === "error" ? (
        <p className="lx-form-status error" role="alert">{error}</p>
      ) : null}

      <button className="btn btn-solid lx-form-submit" type="submit" disabled={!canSubmit}>
        {status === "submitting" ? "Sending…" : <>Send message <Arrow /></>}
      </button>
      <p className="lx-form-fine">
        We use your details only to reply about Sutra. No account is created and nothing is shared.
      </p>
    </form>
  );
}
