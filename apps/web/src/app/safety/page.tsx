import { SAFETY_DISCLOSURE } from "./disclosure.js";

/** Safety center (DEC-008): blocking/reporting disclosures + consent order. */
export default function SafetyPage() {
  return (
    <main>
      <h1>Safety</h1>
      <section>
        <h2>Blocking</h2>
        <p>
          Blocking is silent and bilateral. The blocked user is never told they were blocked;
          existing conversations stay readable with sends disabled.
        </p>
      </section>
      <section>
        <h2>Reporting</h2>
        <p>{SAFETY_DISCLOSURE}</p>
        <p>
          Excerpts require explicit per-report consent and a client-side preview before submission.
          No blanket consent exists.
        </p>
      </section>
    </main>
  );
}
