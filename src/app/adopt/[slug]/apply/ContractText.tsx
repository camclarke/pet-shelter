/**
 * The shelter's contract, rendered. PRESENTATIONAL ONLY: no hooks, no
 * Firebase, nothing but the config text in and markup out — so it renders the
 * same on the server (/adopt/contract), in the stepper and in a static render
 * measured at 360px.
 *
 * ═══ NOTHING DISPLAYED MAY DIFFER FROM WHAT IS HASHED ══════════════════════
 * Every block is `ADOPTION_CONTRACT`'s own string, verbatim: the heading, the
 * opening, each clause, the closing, then each additional clause's title and
 * paragraphs. The only thing this file adds is what
 * goes in the two blanks — the applicant's name and C.I. on the review, or an
 * empty dotted line (with words for a screen reader) everywhere else. A test
 * strips the tags from the static markup and compares it, block by block,
 * with `contractCanonicalText()` with the tokens replaced.
 *
 * The blanks are split out as React nodes (`splitContractOpening`), never by
 * string substitution: nothing is HTML-injected, and a name that itself
 * contains `{ci}` stays literal text.
 *
 * ⚠️ No signature lines: the checkbox is the signature (owner, 2026-10-21).
 * The acceptance note beside it is the caller's, and sits OUTSIDE this
 * block on purpose.
 */

import {
  CONTRACT_CI_TOKEN,
  CONTRACT_NAME_TOKEN,
  type AdoptionContract,
} from '@/config/adoption-contract';
import { splitContractOpening } from '@/lib/application-steps';
import { t } from '@/i18n';

export interface ContractTextProps {
  contract: AdoptionContract;
  /**
   * `blank`: dotted lines, as on paper (step 1, /adopt/contract).
   * `filled`: the applicant's own name and C.I., in bold (the review step).
   */
  mode: 'blank' | 'filled';
  name?: string | null;
  ci?: string | null;
  /** The heading level of the contract's own heading. */
  headingLevel?: 'h2' | 'h3';
}

function Blank({ words }: { words: string }) {
  return (
    <span className="contract__blank">
      <span className="sr-only">{words}</span>
    </span>
  );
}

export function ContractText({ contract, mode, name, ci, headingLevel = 'h3' }: ContractTextProps) {
  const copy = t.applicationSteps;
  const Heading = headingLevel;
  // One level below the contract's own heading.
  const ClauseHeading = headingLevel === 'h2' ? 'h3' : 'h4';
  const parts = splitContractOpening(contract.opening, CONTRACT_NAME_TOKEN, CONTRACT_CI_TOKEN);
  const emphasized = new Set(contract.emphasizedClauses);

  return (
    <section className="contract" aria-label={copy.contractLabel}>
      {contract.heading && <Heading className="contract__heading">{contract.heading}</Heading>}
      <p className="contract__opening">
        {parts.map((part, i) => {
          if (part.kind === 'text') return <span key={i}>{part.text}</span>;
          const value = part.kind === 'name' ? name : ci;
          if (mode === 'filled' && value) {
            return (
              <strong key={i} className="contract__filled">
                {value}
              </strong>
            );
          }
          return <Blank key={i} words={part.kind === 'name' ? copy.blankName : copy.blankCi} />;
        })}
      </p>
      <ul className="contract__clauses">
        {contract.clauses.map((clause, i) => (
          <li key={i}>{emphasized.has(i) ? <strong>{clause}</strong> : clause}</li>
        ))}
      </ul>
      <p className="contract__closing">{contract.closing}</p>
      {contract.additionalClauses.map((clause) => (
        <div key={clause.title} className="contract__additional">
          <ClauseHeading className="contract__additional-title">{clause.title}</ClauseHeading>
          {clause.blocks.map((block, i) => (
            <p key={i}>{block}</p>
          ))}
        </div>
      ))}
    </section>
  );
}
