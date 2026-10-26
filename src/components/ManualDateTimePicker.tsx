import { useEffect, useRef, useState } from 'react';
import { resolveManualDraft, type InstantChoice, type ManualDraft } from '../lib/manualDateTime';

export interface ManualDateTimePickerProps {
  initialDraft: ManualDraft;
  onApply(choice: InstantChoice): void;
  onCancel(): void;
}

export function ManualDateTimePicker({ initialDraft, onApply, onCancel }: ManualDateTimePickerProps) {
  const [draft, setDraft] = useState(initialDraft);
  const dateRef = useRef<HTMLInputElement>(null);
  const resolution = resolveManualDraft(draft);
  // Resolve without a choice to keep both radio options visible after selection.
  const wallTime = resolveManualDraft({ ...draft, offset: null });
  const message = resolution.kind === 'invalid' ? resolution.message
    : resolution.kind === 'ambiguous' ? 'This time occurs twice. Choose its UTC offset.' : null;

  useEffect(() => { dateRef.current?.focus(); }, []);

  return (
    <form className="manual-editor" aria-label="Choose date and time"
      onSubmit={event => {
        event.preventDefault();
        event.stopPropagation();
        if (resolution.kind === 'valid') onApply(resolution.choice);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}>
      <div className="manual-heading">Choose date and time</div>
      <div className="manual-fields">
        <label htmlFor="manual-date">Date
          <input ref={dateRef} id="manual-date" type="date" required value={draft.date}
            aria-invalid={resolution.kind === 'invalid'} aria-describedby="manual-zone manual-validation"
            onChange={event => { const date = event.target.value; setDraft(current => ({ ...current, date, offset: null })); }} />
        </label>
        <label htmlFor="manual-time">Time
          <input id="manual-time" type="time" step="1" required value={draft.time}
            aria-invalid={resolution.kind === 'invalid'} aria-describedby="manual-zone manual-validation"
            onChange={event => { const time = event.target.value; setDraft(current => ({ ...current, time, offset: null })); }} />
        </label>
      </div>
      <div id="manual-zone" className="manual-zone">{draft.timeZone}{resolution.kind === 'valid' ? ` · UTC${resolution.choice.offset}` : ''}</div>
      {wallTime.kind === 'ambiguous' && (
        <fieldset className="manual-offsets">
          <legend>UTC offset</legend>
          {wallTime.choices.map((choice, index) => (
            <label key={choice.offset}>
              <input type="radio" name="manual-offset" value={choice.offset} checked={draft.offset === choice.offset}
                onChange={() => setDraft({ ...draft, offset: choice.offset })} />
              {index === 0 ? 'First' : 'Second'} occurrence · UTC{choice.offset}
            </label>
          ))}
        </fieldset>
      )}
      <div id="manual-validation" className="manual-validation" role="status">{message}</div>
      <div className="manual-actions">
        <button className="manual-apply" type="submit" disabled={resolution.kind !== 'valid'}>Use date/time</button>
        <button className="manual-cancel" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
