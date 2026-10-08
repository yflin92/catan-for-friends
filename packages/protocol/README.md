# @hexlands/protocol

Wire messages, zod schemas, shared enums and close codes for Hexlands (design §2.2, §3.11; ADR-0004).

## Parsing policy (design D6)

| Direction | Schema | Unknown keys |
|---|---|---|
| client → server | `clientMsgSchema` and its members | **rejected**. hello/action/lobby/control get `rule/malformed_action`; signals are dropped. |
| server → client envelopes | `serverMsgSchema` (`welcome`, `state`, `room`, `outcome`, …) | **rejected** |
| server → client `view` and `room` | `serverMsgSchema` | **preserved**, never stripped. Unknown log event kinds parse as `UnknownGameEvent`. |

Nothing is ever defaulted, coerced, transformed or stripped, so a parsed view is byte-for-byte what the server sent
and client-side view hashes match the server's (D5).

`@hexlands/protocol/testing` exports `serverMsgSchemaStrict`: the same shapes, strict everywhere, known log kinds only.
CI parses real server and engine output with it so drift fails before deploy. No production module of an app or a
package may import it.

## Compatibility rule (ADR-0004 rev 1.5)

`PROTOCOL_VERSION` stays the same for:
- a new optional or ignorable field anywhere under a server `view` or `room`;
- a new log event kind.

`PROTOCOL_VERSION` is bumped for:
- removing or retyping a field, or changing a field's meaning;
- a new required client → server field;
- a new value in a closed enum the client acts on (`ReasonCode`, `OutcomeResult`, close codes);
- a new `ServerMsg` envelope field or message type.

One exception, before the first release: the `room` envelope's `yourSeat` field (design D9) was added without a bump,
because no client had shipped against version 1 yet. From the first release on, the rule above applies without
exception.

`room.buildVersion` carries the server's build id. A client whose own build differs shows a non-blocking
"new version available" notice and never auto-reloads with actions pending.
