import { cli, defineAgent, ServerOptions, voice, type JobContext, type llm } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { voiceAccess } from "./provider-access";
import {
  EVENT_TOPIC, SNAPSHOT_RPC, TURN_RPC, HIGHLIGHT_RPC, EDIT_RPC, RUN_RPC,
  QUESTION, mockReply, snapshotContext, snapshotSchema, turnSchema,
  editResponseSchema, runResponseSchema, type AgentEvent, type EditorSnapshot
} from "../src/lib/protocol";

const metadataSchema = z.object({ candidateIdentity: z.string().startsWith("candidate-"), mode: z.enum(["mock", "voice"]) });

const TWO_SUM_SOLUTION = `export function twoSum(nums: number[], target: number): [number, number] | null {
  const map = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) {
      return [map.get(complement)!, i];
    }
    map.set(nums[i], i);
  }
  return null;
}
`;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const metadata = metadataSchema.parse(JSON.parse(ctx.room.metadata || "{}"));
    if (metadata.mode !== (process.env.AGENT_MODE || "mock")) throw new Error("Web and agent modes differ. Restart both after changing .env.local.");
    await ctx.waitForParticipant(metadata.candidateIdentity);
    const local = ctx.room.localParticipant!;

    const emit = async (event: AgentEvent) => {
      await local.sendText(JSON.stringify(event), { topic: EVENT_TOPIC, destinationIdentities: [metadata.candidateIdentity] });
    };

    const reportError = async (msg = "This turn could not finish. Check the agent terminal and connection; no successful action is assumed.") => {
      await emit({ kind: "error", id: randomUUID(), text: msg }).catch(() => {});
    };

    const capture = async (turnId: string): Promise<EditorSnapshot> => {
      const raw = await local.performRpc({ destinationIdentity: metadata.candidateIdentity, method: SNAPSHOT_RPC, payload: JSON.stringify({ turnId }), responseTimeout: 5000 });
      const snapshot = snapshotSchema.parse(JSON.parse(raw));
      await emit({ kind: "context", id: turnId, snapshot });
      return snapshot;
    };

    const performHighlight = async (documentId: string, revision: number, lineStart?: number, lineEnd?: number, snippet?: string, clear?: boolean) => {
      await local.performRpc({
        destinationIdentity: metadata.candidateIdentity,
        method: HIGHLIGHT_RPC,
        payload: JSON.stringify({ documentId, revision, lineStart, lineEnd, snippet, clear }),
        responseTimeout: 5000,
      });
      await emit({ kind: "highlight", id: randomUUID(), lineStart, lineEnd, snippet, clear, text: clear ? "Cleared highlight" : `Highlighted code lines ${lineStart || 1}-${lineEnd || lineStart || 1}` });
    };

    const performEdit = async (documentId: string, baseRevision: number, editType: "replace" | "insert" | "delete", targetSnippet: string, newCode: string, rationale?: string) => {
      const raw = await local.performRpc({
        destinationIdentity: metadata.candidateIdentity,
        method: EDIT_RPC,
        payload: JSON.stringify({ documentId, baseRevision, editType, targetSnippet, newCode, rationale }),
        responseTimeout: 5000,
      });
      const res = editResponseSchema.parse(JSON.parse(raw));
      await emit({ kind: "edit", id: randomUUID(), editType, success: res.success, revision: res.revision, text: res.success ? `Directly updated code (${editType}) to revision ${res.revision}` : `Edit failed: ${res.error}` });
      return res;
    };

    const performRun = async (documentId: string, revision: number, code: string) => {
      await emit({ kind: "run", id: randomUUID(), status: "running", revision, output: "Executing code..." });
      const raw = await local.performRpc({
        destinationIdentity: metadata.candidateIdentity,
        method: RUN_RPC,
        payload: JSON.stringify({ documentId, revision, code }),
        responseTimeout: 10000,
      });
      const res = runResponseSchema.parse(JSON.parse(raw));
      await emit({ kind: "run", id: randomUUID(), status: res.status, revision: res.revision, output: res.output, durationMs: res.durationMs });
      return res;
    };

    let session: voice.AgentSession | undefined;
    if (metadata.mode === "voice") {
      const access = voiceAccess(process.env);
      const [openai, deepgram, elevenlabs, silero] = await Promise.all([
        import("@livekit/agents-plugin-openai"), import("@livekit/agents-plugin-deepgram"),
        import("@livekit/agents-plugin-elevenlabs"), import("@livekit/agents-plugin-silero"),
      ]);

      let lastSnapshot: EditorSnapshot | null = null;

      class EditorAgent extends voice.Agent {
        async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage) {
          if (!newMessage.textContent?.trim()) throw new voice.StopResponse();
          try {
            const snapshot = await capture(newMessage.id);
            lastSnapshot = snapshot;
            newMessage.content.push(snapshotContext(snapshot));
          } catch {
            await reportError();
            throw new voice.StopResponse();
          }
        }
      }

      session = new voice.AgentSession({
        vad: await silero.VAD.load(),
        stt: new deepgram.STT({ ...access.deepgram, model: "nova-3", language: "en" }),
        llm: new openai.LLM({ ...access.openai, model: process.env.OPENAI_MODEL || "gpt-4.1-mini", maxCompletionTokens: 500 }),
        tts: new elevenlabs.TTS({ ...access.elevenlabs, voiceId: access.voiceId, model: "eleven_flash_v2_5" }),
        turnHandling: {
          turnDetection: "vad",
          interruption: { mode: "vad" },
          preemptiveGeneration: { enabled: false },
        },
      });

      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, event => {
        if (event.isFinal) void emit({ kind: "transcript", id: event.itemId || randomUUID(), role: "user", text: event.transcript }).catch(() => {});
      });
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, event => {
        if (event.item.type === "message" && event.item.role === "assistant" && event.item.textContent) void emit({ kind: "transcript", id: event.item.id, role: "agent", text: event.item.textContent }).catch(() => {});
      });
      session.on(voice.AgentSessionEventTypes.Error, () => { void reportError(); });

      await session.start({
        room: ctx.room,
        agent: new EditorAgent({
          instructions: `You are an interactive programming assistant. The user is working on: ${QUESTION}
You have access to their live editor code and can highlight code, edit code directly, and run code execution!
- Highlight: call highlight_code when explaining code to highlight relevant lines.
- Edit: call edit_code when requested to replace, insert, or delete code in the editor directly.
- Run: call run_code when asked to execute the code and discuss the output.
Keep spoken responses short, concise, and helpful.`
        }),
        inputOptions: { textEnabled: false, participantIdentity: metadata.candidateIdentity },
        record: false,
      });

      ctx.addShutdownCallback(async () => { await session?.close(); });
    }

    const accepted = new Set<string>();
    let pending = false;
    local.registerRpcMethod(TURN_RPC, async data => {
      if (data.callerIdentity !== metadata.candidateIdentity) throw new Error("Unexpected participant.");
      const turn = turnSchema.parse(JSON.parse(data.payload));
      if (accepted.has(turn.id)) return "already accepted";
      if (pending) throw new Error("A text turn is being accepted. Retry shortly.");
      pending = true;
      try {
        const snapshot = await capture(turn.id);
        await emit({ kind: "transcript", id: turn.id, role: "user", text: turn.text });

        const lower = turn.text.toLowerCase();

        // Perform mock or voice action triggers based on user prompt
        if (lower.includes("explain") || lower.includes("loop") || lower.includes("read")) {
          await performHighlight(snapshot.documentId, snapshot.revision, 1, Math.min(4, snapshot.code.split("\n").length), snapshot.code.split("\n")[0]);
        }

        if (lower.includes("edit") || lower.includes("replace") || lower.includes("write") || lower.includes("code")) {
          await performEdit(snapshot.documentId, snapshot.revision, "replace", snapshot.code, TWO_SUM_SOLUTION, "Replaced with optimal Map solution");
        }

        if (lower.includes("run") || lower.includes("execute")) {
          await performRun(snapshot.documentId, snapshot.revision, snapshot.code);
        }

        let extraMsg = "";
        if (lower.includes("edit") || lower.includes("replace")) {
          extraMsg = "\n[Action Executed] Replaced editor code with optimized O(n) Map solution!";
        } else if (lower.includes("run") || lower.includes("execute")) {
          extraMsg = "\n[Action Executed] Code executed in isolated sandbox!";
        } else if (lower.includes("explain") || lower.includes("read")) {
          extraMsg = "\n[Action Executed] Highlighted active code lines!";
        }

        let voiceResponded = false;
        if (session) {
          try {
            session.interrupt();
            session.generateReply({ userInput: `${turn.text}\n\n${snapshotContext(snapshot)}` });
            voiceResponded = true;
          } catch {
            voiceResponded = false;
          }
        }

        if (!voiceResponded) {
          await emit({ kind: "transcript", id: `${turn.id}:reply`, role: "agent", text: mockReply(turn.text, snapshot) + extraMsg });
        }

        accepted.add(turn.id);
        if (accepted.size > 100) accepted.delete(accepted.values().next().value!);
        return "accepted";
      } catch (e) { await reportError(); throw e; }
      finally { pending = false; }
    });

    await local.setAttributes({ "assignment.ready": "true" });
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url), host: "127.0.0.1", port: 8082,
  numIdleProcesses: 1,
  loadFunc: async worker => worker.activeJobs.length / 4,
  loadThreshold: 1,
}));
