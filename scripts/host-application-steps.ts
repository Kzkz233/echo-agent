import{seedProfile,seedRoutes}from'./inference-fixture.ts';
import { Application } from '../apps/server/application.ts';
import type { Profile } from '../packages/contracts/index.ts';
export async function verifyHostApplication(
  app: Application,
  profile: Profile,
  captured: () => unknown,
  restart?: () => Promise<void>,
) {
  for (const id of ['knowledge', 'persona', 'memory', 'review']) await app.plugins.enable(id);
  const persona = app.personas.get('companion')!;
  await app.personas.save({
    ...persona,
    prompt: persona.prompt + '\nAPPLICATION_PERSONA_SENTINEL',
  });
  seedProfile(app,profile);
  seedRoutes(app, { chat: profile.id, review: profile.id });
  app.store.set('memory.config', { planner: false, useSemantic: false });
  await app.memories.save({
    personaId: persona.id,
    title: '虚构小猫',
    text: 'APPLICATION_RECALL_SENTINEL：虚构小猫云朵喜欢蓝色玩具。',
    core: false,
    tags: ['猫', '玩具'],
    sources: [],
  });
  const conversationId = 'host-' + profile.id;
  app.store.saveConversation({
    id: conversationId,
    title: 'Synthetic host conversation',
    personaId: persona.id,
    injection: true,
    review: true,
    createdAt: new Date().toISOString(),
  });
  const run = await app.router.send({
    conversationId,
    requestId: 'native-host-chat',
    text: '虚构小猫云朵喜欢什么玩具？',
  });
  if (run.state !== 'succeeded')
    throw Error('Native application chat: ' + run.state + ' ' + run.error);
  const input = JSON.stringify(captured());
  if (
    !input.includes('APPLICATION_PERSONA_SENTINEL') ||
    !input.includes('APPLICATION_RECALL_SENTINEL')
  )
    throw Error('Real host did not receive actual Persona / Memory provider output');
  if (!app.store.allMessages(conversationId).some((m) => m.meta.kind === 'memory'))
    throw Error('Actual recall injection receipt missing');
  await restart?.();
  const continued = await app.router.send({
    conversationId,
    requestId: 'native-host-continue',
    text: '接着刚才关于云朵玩具的话题。',
  });
  if (
    continued.state !== 'succeeded' ||
    !JSON.stringify(captured()).includes('APPLICATION_RECALL_SENTINEL')
  )
    throw Error('Native same-conversation continuation lost context');
  const job = await app.reviews.start(persona.id, 'native-host-review');
  const began = Date.now();
  while (true) {
    const current = app.reviews.jobs().find((j) => j.id === job.id)!;
    if (current.state === 'completed') break;
    if (current.state === 'paused' || Date.now() - began > 40000)
      throw Error('Native host Review did not finish: ' + current.error);
    await new Promise((r) => setTimeout(r, 25));
  }
  return {
    actualPersonaInjection: true,
    actualRecallReachedModel: true,
    sameConversationContinued: true,
    reviewCompletedThroughHost: true,
  };
}
