import { useState, useEffect, useRef } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';
export const agendaDragType = 'application/x-echo-agenda';
export function startAgendaDrag(event: React.DragEvent, item: { id: string; revision: number }) {
  event.stopPropagation();
  clearAgendaDrag();
  event.currentTarget.classList.add('agenda-drag-source');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(
    agendaDragType,
    JSON.stringify({ id: item.id, revision: item.revision }),
  );
}
function clearAgendaDrag() {
  document
    .querySelectorAll('.agenda-drag-source,.agenda-drop-target')
    .forEach((element) => element.classList.remove('agenda-drag-source', 'agenda-drop-target'));
}
export function useAgendaMove(act: any, refresh: () => Promise<unknown>) {
  const lock = useRef(false);
  const [change, setChange] = useState<string>(),
    [moving, setMoving] = useState(false);
  useEffect(() => {
    const end = () => clearAgendaDrag();
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end, true);
    return () => {
      end();
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', end, true);
    };
  }, []);
  const hover = (event: React.DragEvent) => {
    if (lock.current || !event.dataTransfer.types.includes(agendaDragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.agenda-drop-target').forEach((element) => {
      if (element !== event.currentTarget) element.classList.remove('agenda-drop-target');
    });
    event.currentTarget.classList.add('agenda-drop-target');
  };
  const leave = (event: React.DragEvent) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      event.currentTarget.classList.remove('agenda-drop-target');
  };
  const drop = async (
    event: React.DragEvent,
    date: string,
    extensions?: Record<string, unknown>,
  ) => {
    if (!event.dataTransfer.types.includes(agendaDragType) || lock.current) return;
    event.preventDefault();
    event.stopPropagation();
    let item: any;
    try {
      item = JSON.parse(event.dataTransfer.getData(agendaDragType));
    } catch {
      return;
    }
    if (typeof item.id !== 'string' || !Number.isInteger(item.revision)) return;
    lock.current = true;
    setMoving(true);
    try {
      await act(async () => {
        const result = await rpc('agenda.reschedule', {
          ...item,
          date,
          extensions,
          requestId: crypto.randomUUID(),
        });
        setChange(result.id);
        await refresh();
      }, t('日程已改期'));
    } finally {
      lock.current = false;
      clearAgendaDrag();
      setMoving(false);
    }
  };
  const undo = change ? (
    <Button
      secondary
      onClick={() =>
        act(async () => {
          await rpc('agenda.undo', { changeId: change, requestId: crypto.randomUUID() });
          setChange(undefined);
          await refresh();
        }, t('已撤销改期'))
      }
    >
      {t('撤销改期')}
    </Button>
  ) : null;
  return { drop, undo, moving, hover, leave };
}
export function AgendaFields({ fields, value, onChange }: any) {
  return (
    <>
      {fields.flatMap((provider: any) =>
        provider.fields.map((field: any) => {
          const selected = value?.[provider.owner]?.[field.key] ?? '';
          return (
            <label className="field" key={provider.id + ':' + field.key}>
              <span>{t(field.label)}</span>
              <select
                aria-label={t(field.label)}
                value={selected}
                onChange={(event) =>
                  onChange({
                    ...value,
                    [provider.owner]: {
                      ...value?.[provider.owner],
                      [field.key]: event.target.value || undefined,
                    },
                  })
                }
              >
                <option value="">{t('未选择')}</option>
                {selected && !field.options.some((o: any) => o.value === selected) && (
                  <option value={selected}>{selected}</option>
                )}
                {field.options.map((option: any) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }),
      )}
    </>
  );
}
