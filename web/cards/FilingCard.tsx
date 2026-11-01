import { folderDest } from '../../shared/labels';
import type { CardProps } from './registry';
import { CardHead, ChoiceError, FolderCombo, GmailLink, Options, Sender, useChoice, useOptionKeys } from './parts';

/** "Where should this go?": Jev's top three, any other folder, or keep it. */
export function FilingCard({ card, folders, onChoose, context }: CardProps) {
  const { choose, win, error } = useChoice(onChoose);
  const pickOption = (i: number) => {
    const o = card.options[i];
    if (o) choose(o.dest, undefined, `opt:${i}`, true);
  };
  useOptionKeys(true, pickOption);
  const noOptions = card.options.length === 0;

  return (
    <article className="card" aria-label={`Email: ${card.subject}`}>
      <CardHead card={card} title="Where should this go?" context={context} />
      <Sender card={card} />
      <div className="subj">{card.subject}</div>
      <div className="body">{card.body}</div>
      {card.why && <div className="why fade-in"><b>Why I'm asking:</b> {card.why}</div>}
      {!noOptions && <Options options={card.options} win={win} onPick={pickOption} />}
      <ChoiceError error={error} />
      <div className="row card-row">
        <FolderCombo folders={folders} disabled={win !== null} onPick={(name) => choose(folderDest(name), undefined, 'other')} />
        {noOptions && (
          <button type="button" className={`btn${win === 'archive' ? ' dark' : ''}`} onClick={() => choose('archive', undefined, 'archive')}>
            Archive
          </button>
        )}
        <button type="button" className={`btn${card.suggestKeep || win === 'keep' ? ' dark' : ''}`}
          onClick={() => choose('keep', undefined, 'keep')}>Keep in inbox</button>
        <GmailLink href={card.gmailUrl} />
      </div>
    </article>
  );
}
