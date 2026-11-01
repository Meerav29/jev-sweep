import { useState } from 'react';
import type { CardProps } from './registry';
import { CardHead, ChoiceError, FolderCombo, GmailLink, Options, Sender, useChoice, useOptionKeys } from './parts';

/** "Read this one": a summary first; filing it is a second step, on the same card. */
export function ImportantCard({ card, folders, onChoose, context }: CardProps) {
  const { choose, win, error } = useChoice(onChoose);
  const [filing, setFiling] = useState(false);
  const pickOption = (i: number) => {
    const o = card.options[i];
    if (o) choose(o.dest, undefined, `opt:${i}`, true);
  };
  useOptionKeys(filing, pickOption);
  const noOptions = card.options.length === 0;

  return (
    <article className={`card imp${filing ? ' filing' : ''}`} aria-label={`Important email: ${card.subject}`}>
      <CardHead card={card} title="● Read this one" context={context} />
      <Sender card={card} />
      <div className="subj">{card.subject}</div>
      {card.summary && card.summary.length > 0 && (
        <div className="tldr">
          <div className="k">The short version</div>
          <ul>{card.summary.map((s, i) => <li key={i} style={{ ['--i' as string]: i }}>{s}</li>)}</ul>
        </div>
      )}
      <div className="body">{card.body}</div>
      <ChoiceError error={error} />
      {!filing ? (
        <div className="row card-row">
          <button type="button" className="btn dark" onClick={() => setFiling(true)}>Got it, file it</button>
          <button type="button" className={`btn${win === 'reply' ? ' dark' : ''}`}
            onClick={() => choose('keep', { star: true }, 'reply')}>Keep in inbox, needs reply</button>
          <GmailLink href={card.gmailUrl} />
        </div>
      ) : (
        <div className="follow">
          <div className="k">Where should it go?</div>
          {!noOptions && <Options options={card.options} win={win} onPick={pickOption} />}
          <div className="row card-row">
            <FolderCombo folders={folders} disabled={win !== null} onPick={(name) => choose(`label:${name}`, undefined, 'other')} />
            {noOptions && (
              <>
                <button type="button" className="btn" onClick={() => choose('archive', undefined, 'archive')}>Archive</button>
                <button type="button" className="btn" onClick={() => choose('keep', undefined, 'keep')}>Keep in inbox</button>
              </>
            )}
            <GmailLink href={card.gmailUrl} />
          </div>
        </div>
      )}
    </article>
  );
}
