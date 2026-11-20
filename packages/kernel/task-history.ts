import { describeFailure } from './task-failure.ts';
import type { Deliveries } from './delivery.ts';
import type { Store } from './store.ts';
import type { OutputEnvelope } from '../contracts/delivery.ts';

// Match durable identities only. Older plugins stored the task reference in the
// delivery plan or in the originating work session, before explicit result refs.
export function taskHistory(
  store: Store,
  deliveries: Deliveries,
  type: string,
  id: string,
  personaId?: string,
) {
  const rows = store.db
    .prepare(
      `
    SELECT m.data FROM messages m
    JOIN conversations c ON c.id=m.conversation_id
    JOIN receipts r ON r.id='task-result.'||json_extract(m.data,'$.meta.taskResultId')
    LEFT JOIN documents w ON w.namespace='work-sessions' AND w.id=json_extract(r.data,'$.context.workSessionId')
    WHERE json_extract(m.data,'$.meta.taskResultId') IS NOT NULL AND m.id=json_extract(r.data,'$.messageId')
      AND ($persona IS NULL OR json_extract(c.data,'$.personaId')=$persona)
      AND (EXISTS (SELECT 1 FROM json_each(r.data,'$.context.tasks') t WHERE json_extract(t.value,'$.type')=$type AND json_extract(t.value,'$.id')=$id)
        OR (json_extract(r.data,'$.context.tasks') IS NULL AND (
          (json_extract(r.data,'$.request.delivery.task.type')=$type AND json_extract(r.data,'$.request.delivery.task.id')=$id)
          OR (json_extract(w.data,'$.origin.type')=$type AND json_extract(w.data,'$.origin.id')=$id)
          OR ($type='delegation' AND json_extract(m.data,'$.meta.taskResultId') IN
            (SELECT json_extract(d.data,'$.requestId') FROM receipts d WHERE d.id GLOB $prefix
             AND substr(d.id,length($base)+1) NOT GLOB '*[^0-9]*')))))
    ORDER BY m.rowid DESC LIMIT 20
  `,
    )
    .all({
      persona: personaId ?? null,
      type,
      id,
      base: 'delegation-return-' + id + '.',
      prefix: 'delegation-return-' + id + '.[0-9]*',
    }) as { data: string }[];
  return rows.map((row) => {
    const message = JSON.parse(row.data);
    const resultId = message.meta.taskResultId;
    const receipt = store.receipt('task-result.' + resultId)!;
    const run = receipt.report ? store.run(resultId) : undefined;
    const parent = run?.conversationId === message.conversationId ? run : undefined;
    const queue = store.receipt('input-' + resultId);
    const outputIds = parent
      ? (
          store.db
            .prepare(
              "SELECT id FROM messages WHERE conversation_id=? AND json_extract(data,'$.runId')=?",
            )
            .all(message.conversationId, parent.id) as { id: string }[]
        ).map((m) => 'message.' + m.id)
      : [];
    if (receipt.context?.outputId) outputIds.push(receipt.context.outputId);
    const outputs = outputIds.flatMap((key) => {
      const out = store.document<OutputEnvelope>('outputs', key);
      return out && out.conversationId === message.conversationId
        ? [{ ...out, deliveries: deliveries.rows(key) }]
        : [];
    });
    const child = receipt.context?.executionRunId ? store.run(receipt.context.executionRunId) : undefined;
    const work = child && receipt.context?.workSessionId && store.document<{conversationId:string; parentConversationId:string}>('work-sessions', receipt.context.workSessionId);
    const childProfile = work?.conversationId === child?.conversationId && work?.parentConversationId === message.conversationId ? child?.profileId : undefined;
    const handoffError = parent?.error ?? queue?.error;
    return {
      executionFailure: receipt.context?.executionState === 'failed' && receipt.text
        ? describeFailure(store, receipt.text, 'execution', childProfile) : undefined,
      handoffFailure: handoffError ? describeFailure(store, handoffError, 'handoff', parent?.profileId) : undefined,
      id: resultId,
      createdAt: message.createdAt,
      text: receipt.text,
      executionState: receipt.context?.executionState,
      handoff: receipt.report
        ? (parent?.state ??
          (queue?.input?.conversationId === message.conversationId ? queue?.state : undefined) ??
          'unconfirmed')
        : 'recorded',
      error: parent?.error ?? queue?.error,
      outputs,
    };
  });
}

// The archive belongs to the role. Its entries outlive the plugin registration.
export function recordedTasks(store:Store, personaId:string) {
  return store.db.prepare(`
    SELECT json_extract(t.value,'$.type') AS type,json_extract(t.value,'$.id') AS id,
           json_extract(m.data,'$.meta.taskResult.task') AS label,json_extract(m.data,'$.createdAt') AS lastAt,
           max(m.rowid) AS latest
    FROM conversations c JOIN messages m ON m.conversation_id=c.id
    JOIN receipts r ON r.id='task-result.'||json_extract(m.data,'$.meta.taskResultId')
    JOIN json_each(coalesce(json_extract(r.data,'$.context.tasks'),
                            json_array(json_extract(r.data,'$.request.delivery.task')))) t
    WHERE json_extract(c.data,'$.personaId')=? AND json_extract(m.data,'$.meta.taskResultId') IS NOT NULL
      AND json_extract(r.data,'$.messageId')=m.id AND json_extract(t.value,'$.id') IS NOT NULL
      AND json_extract(t.value,'$.type')!='delegation'
    GROUP BY json_extract(t.value,'$.type'),json_extract(t.value,'$.id') ORDER BY latest DESC
  `).all(personaId).map(({latest,...row})=>row);
}
