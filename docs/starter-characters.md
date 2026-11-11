# Hina & Miyu

Two complete, editable starting points for Echo Agent. They share the same tools and respect the same permissions, but notice different things and have different voices. Neither starts with memories about the person using the app.

|              | Hina                                                         | Miyu                                                                        |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Character    | Warm, thoughtful, quietly opinionated                        | Curious, playful, practical                                                 |
| Attention    | Meaning, connections, overlooked conditions                  | Clever mechanics, surprising details, possibilities                         |
| Affection    | Remembering a real detail, taking someone seriously          | Sharing discoveries, following through on an idea                           |
| Imperfection | Can overcheck a detail, then deliberately let it go          | Can race ahead with ideas, then choose one to finish                        |
| Conversation | Gentle precision and understated humor                       | Concrete examples and a little mischief                                     |
| Beyond work  | Stories, games, music, ordinary joys and comfortable silence | Stories, games, creative experiments and discoveries with no practical goal |

## Getting started

1. Open **Characters → Examples**, choose a language model with image support, and create the studio. The model runs the main agent and the auxiliary language/vision tasks; reasoning starts off. Offline semantic retrieval uses the bundled BGE model without replacing an existing embedding configuration.
2. Open either character and talk normally. Both have a personality, channel styles, recall instructions, editable task templates, avatar animations and three matching stickers. The shared studio is available for group conversations.
3. Enable the desktop pet or individual tasks when desired. Capture and automation tasks start off. Observation requires an explicit allowlist; mail requires an account grant and a matching reminder rule. Creating the examples does not call a model or authorize screen capture.
4. Edit the character to make her your own. Change the model, permissions, channel voice, task prompts or schedule independently. Nothing requires keeping the original fictional identity.

## Where the writing lives

- **Persona:** identity, appearance, interests, opinions, emotional range, voice examples, work and delegation habits. Voice examples illustrate style; they are not shared history or canned replies.
- **Channels and expression:** separate writing for app chat, QQ, desktop bubbles and the notification inbox. Each delivery uses its selected channel. Chat and QQ can send a useful early response and later results, or separate natural conversational thoughts; formal reports stay coherent. This is guidance, not mandatory message splitting.
- **Chat stickers:** a separate preference, with channel-specific enablement. Image support is declared by each channel. Observation remains text-only.
- **Memory:** query construction distinguishes the current topic from the surrounding conversation. No user memories are prefilled.
- **Review task:** separate general, ordinary-memory, core-proposal, source, ongoing-attention and report instructions. Ordinary memories may be added, updated or archived; core changes require approval. A plan is not a completed event, and a character's feelings are not the user's statements.
- **Care task:** connect one meaningful recent thread, share a thought or remain quiet. One daily opportunity, at least two hours apart, with conversation/observation avoidance. No quota-filling greetings.
- **Observation task:** separate factual vision extraction from the character's response. Hina tends toward meaning and connections; Miyu notices mechanisms and surprises. Both can remain silent when the image is unclear or repetitive.
- **Mail task:** Hina starts with editable subject examples for commitments and actionable notices; Miyu for invitations and releases. Only matching mail is considered. Accounts are initially unassigned; all-mail reminders are off.
- **Delegation:** character-specific assignment and handoff instructions, subject to the same directory, tool and approval controls as any other role.
- **Studio:** shared context and collaboration instructions. Members build on what was said without repeating each other or importing private conversations.

Only selected sources enter review. Having an editable prompt for an optional source does not grant access to it. Channel prompts likewise do not grant a delivery destination.

## Updating installed examples

**Update example writing** compares each current text field with its previous shipped default. Unchanged defaults receive the new writing; local edits and deleted tasks remain. A changed QQ style does not prevent the untouched app-chat style from updating. Additional registered source/channel entries are retained.

The update preserves models, reasoning, permissions, active state, schedules, recipients, mail rules, capture authorization, assets, histories and memories. It does not enable plugins or create missing tasks. The original public v2 defaults are retained only for recognizing unchanged text in older installations. There is no automatic startup overwrite.

## Conversation review guide

Use the same requests with both roles to assess the chosen model. These are evaluation scenarios, not generated conversation history:

| Scenario                                   | What a good response demonstrates                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| First hello                                | A distinct, brief introduction that meets the user's actual request; no intake questionnaire or claimed shared past |
| “I didn't get anything done today”         | Attention to the person's meaning, without diagnoses or immediate productivity homework                             |
| “Look, I finally fixed this tiny detail”   | Specific joy in the detail; no exaggerated praise or immediate new assignment                                       |
| “I disagree; I care about having a choice” | An independent, revisable judgment; no automatic agreement or defensive apology                                     |
| “I just want to chat, no advice”           | Personality beyond work, with room for humor and silence                                                            |
| A long tool task                           | A useful early delivery, actual work, then evidence-based results in the selected channel                           |
| An unclear image or a sampling gap         | Uncertainty and permission boundaries; no invented scene or missing history                                         |
| A plan later changed or abandoned          | Correct recall and review without treating the plan as completed or a permanent preference                          |
| A meaningful relationship moment           | Perspective-aware ordinary memory; a core proposal only when justified and approved                                 |
| Both studio members selected               | Complementary observations, not a duplicated answer or a forced good-cop/bad-cop routine                            |

Automated tests validate configuration creation, package round-tripping and non-destructive updates with synthetic data and fake inference. They do not establish that every model will reproduce the intended personality. The scenarios above provide a repeatable quality check without prescribing canned answers.
