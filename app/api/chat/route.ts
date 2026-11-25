import { google } from '@ai-sdk/google';
import { APICallError, streamText, generateText, type LanguageModelUsage } from 'ai';
import { GoogleGenAI } from '@google/genai';
import { getEnterpriseCopilotContext, HttpError, isJiraAccessAvailable, requireChatProject, requireUser } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertValidAnswer, encodeEvent, ENTERPRISE_NO_EVIDENCE, isNoEvidenceAnswer, NO_EVIDENCE, MAX_ANSWER_CHARS, type AgentStepEventData, type ChatEvent } from '@/lib/chat-contract';
import { getSystemPrompt } from '@/lib/prompts/systemPrompt';

import {
  requestsPermissionChange,
  getDeterministicIntent,
  getDeterministicResponse,
  parseChatInput,
} from '@/lib/chat-input';
import {
  MAX_AGENT_STEPS,
  MAX_RETRIEVAL_ATTEMPTS,
  runBoundedRetrievalLoop,
  type AbstentionReason,
  type AgentToolDecision,
  type AgentTrace,
  type EvidenceQuality,
  type TokenCounts,
} from '@/lib/agent-loop';
import { evaluateEvidenceWithLlm, selectAgentToolWithLlm } from '@/lib/llm-agent';
import {
  getTransientGeminiRetryDelayMs,
  isAbortOrTimeoutError,
  isTransientGeminiError,
  sleep,
  withTransientGeminiRetry,
} from '@/lib/gemini-ingestion-retry';
import { retrieveVerifiedChunks } from '@/lib/retrieve-chunks';
import { withTimeout } from '@/lib/with-timeout';
import { citationIndices, safeCitationPrefix, validCitations } from '@/lib/citations';
import { getEnterpriseFallbackQuestions } from '@/lib/enterprise-fallback';
import { lookupEnterpriseJiraStatus } from '@/lib/jira-status';
import {
  draftJiraTicket,
  extractLatestJiraTicketKeyFromMessages,
  formatJiraStatusMessage,
  JIRA_STATUS_CLARIFICATION_PROMPT,
} from '@/lib/jira-ticket';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
const isAbnormalIncompleteFinish = (reason: string) => reason === 'other' || reason === 'error' || reason === 'unknown';
export const runtime = 'nodejs';

type FailureStage = 'agent_decision' | 'stream_initialization' | 'model_stream_iteration' | 'model_stream_finalization'
  | 'answer_validation' | 'interaction_persistence' | 'sse_emission' | 'unknown';
type FailureCategory = 'provider_timeout' | 'provider_error' | 'stream_interrupted' | 'generation_incomplete'
  | 'answer_empty' | 'answer_too_long' | 'invalid_citations' | 'interaction_write_failed'
  | 'request_cancelled' | 'unknown_error';
type EnterpriseRejectionReason = 'none' | 'no_retrieved_chunks' | 'evaluator_abstained' | 'incomplete_finish_reason'
  | 'model_refusal' | 'answer_length_exceeded' | 'invalid_citations' | 'visibility_recheck_failed';

function sanitizeProviderError(error: unknown): {
  status: number | null;
  code: string | null;
  message: string | null;
} {
  if (!APICallError.isInstance(error)) {
    return { status: null, code: null, message: null };
  }
  const status = typeof error.statusCode === 'number' ? error.statusCode : null;
  let code: string | null = null;
  let rawMessage = '';
  if (typeof error.responseBody === 'string') {
    try {
      const parsed = JSON.parse(error.responseBody) as {
        error?: { code?: unknown; status?: unknown; message?: unknown };
      };
      if (typeof parsed?.error?.status === 'string' && /^[A-Z0-9_]+$/.test(parsed.error.status)) {
        code = parsed.error.status;
      } else if (typeof parsed?.error?.code === 'number') {
        code = String(parsed.error.code);
      }
      if (typeof parsed?.error?.message === 'string') {
        rawMessage = parsed.error.message;
      }
    } catch {
      // Ignore non-JSON provider error bodies
    }
  }
  if (!code && status !== null) code = String(status);
  const source = `${rawMessage} ${error.message || ''}`;
  const message = /high demand|spikes in demand|temporarily unavailable|overloaded/i.test(source)
    ? 'This model is currently experiencing high demand. Please try again later.'
    : /quota|rate limit|resource[_\s]exhausted|too many requests/i.test(source)
      ? 'Provider rate limit or quota exceeded.'
      : /deadline exceeded|timed?\s*out/i.test(source)
        ? 'Provider request timed out.'
        : /not found|not supported/i.test(source)
          ? 'Requested model or operation is not available.'
          : /permission|unauthorized|unauthenticated|api key/i.test(source)
            ? 'Provider authentication or permission failed.'
            : status !== null
              ? `Provider returned HTTP ${status}.`
              : 'Provider request failed.';
  return { status, code, message };
}

export async function POST(req: Request) {
  const reqStart = performance.now();
  const interactionId = crypto.randomUUID();
  let isEvalMode = false;
  let stage: FailureStage = 'unknown';
  let cancelled = false;
  let generationDeadline: AbortSignal | undefined;
  let generationSignal: AbortSignal | undefined;
  const failure = {
    failure_stage: null as FailureStage | null,
    failure_category: null as FailureCategory | null,
    provider_error_status: null as number | null,
    provider_error_code: null as string | null,
    provider_error_message: null as string | null,
    model_stream_completed: false,
    interaction_write_started: false,
    retrieved_chunks_found: null as boolean | null,
    model_finish_reason: null as string | null,
    model_refusal: false,
    evaluator_generator_disagreement: false,
    evidence_quality: null as EvidenceQuality | null,
    supporting_chunk_count: null as number | null,
    abstention_reason: null as AbstentionReason | null,
    citation_validation_failed: false,
    answer_length_failed: false,
    visibility_recheck_failed: false,
    enterprise_rejection_reason: null as EnterpriseRejectionReason | null,
  };
  const recordFailure = (failedStage: FailureStage, error: unknown, category: FailureCategory =
    failedStage === 'interaction_persistence' ? 'interaction_write_failed'
      : failedStage === 'model_stream_iteration' ? 'stream_interrupted' : 'unknown_error') => {
    if (failure.failure_stage !== null) return;
    const modelStage = failedStage === 'stream_initialization' || failedStage === 'model_stream_iteration'
      || failedStage === 'model_stream_finalization';
    failure.failure_stage = failedStage;
    const isCancellationError =
      (modelStage && (cancelled || req.signal.aborted))
      || (req.signal.aborted && (error === req.signal.reason || (error instanceof Error && error.name === 'AbortError')));
    const isTimeoutFailure =
      (modelStage && generationDeadline?.aborted && generationSignal?.reason === generationDeadline.reason)
      || (!cancelled && !req.signal.aborted && isAbortOrTimeoutError(error));
    failure.failure_category = isTimeoutFailure
      ? 'provider_timeout'
      : isCancellationError ? 'request_cancelled'
        : APICallError.isInstance(error) ? 'provider_error' : category;
    if (failure.failure_category === 'provider_error') {
      const sanitized = sanitizeProviderError(error);
      failure.provider_error_status = sanitized.status;
      failure.provider_error_code = sanitized.code;
      failure.provider_error_message = sanitized.message;
    }
  };

  const telemetry = {
    request_parse_ms: null as number | null,
    auth_ms: null as number | null,
    rrf_rpc_ms: null as number | null,
    chunk_verify_ms: null as number | null,
    prompt_build_ms: null as number | null,
    model_first_text_ms: null as number | null,
    server_ttft_ms: null as number | null,
    interaction_write_ms: null as number | null,
    server_finish_ready_ms: null as number | null,
    request_mode: null as 'stream' | 'json' | null,
    model_id: null as string | null,
    retrieved_chunk_count: null as number | null,
    context_chars: null as number | null,
    embedding_ms: 0,
    retrieval_ms: 0,
    tool_selection_ms: 0,
    evidence_eval_ms: 0,
    agent_decision_ms: 0,
    ttft_ms: 0,
    generation_ms: 0,
    total_ms: 0,
    retries: { embedding: 0, retrieval: 0, generation: 0, agent_decision: 0 },
    agent: null as AgentTrace | null,
    errors: [] as string[],
    token_usage: { prompt: 0, completion: 0, total: 0 },
    tokens: { prompt: 0, completion: 0, total: 0 },
  };
  const logTiming = (status: 'success' | 'error' | 'cancelled') => {
    if (process.env.NODE_ENV !== 'development') {
      if (process.env.NODE_ENV !== 'production' || status !== 'error') return;
      // Production emits sanitized failure-only telemetry without prompts, evidence, or LLM free-text.
      const prodRecord = {
        type: 'rag_timing',
        interaction_id: interactionId,
        status,
        request_mode: telemetry.request_mode,
        model_id: telemetry.model_id,
        failure_stage: failure.failure_stage,
        failure_category: failure.failure_category,
        provider_error_status: failure.provider_error_status,
        provider_error_code: failure.provider_error_code,
        provider_error_message: failure.provider_error_message,
        model_finish_reason: failure.model_finish_reason,
        model_stream_completed: failure.model_stream_completed,
        enterprise_rejection_reason: failure.enterprise_rejection_reason,
        citation_validation_failed: failure.citation_validation_failed,
        answer_length_failed: failure.answer_length_failed,
        visibility_recheck_failed: failure.visibility_recheck_failed,
        had_first_text: telemetry.model_first_text_ms !== null,
        retrieved_chunk_count: telemetry.retrieved_chunk_count,
        retries: telemetry.retries,
        elapsed_ms: performance.now() - reqStart,
        error_categories: ['request_failed'],
      };
      setImmediate(() => console.info(JSON.stringify(prodRecord)));
      return;
    }
    // Errors can contain provider or document data; only a controlled category is logged.
    const { errors, ...diagnostics } = telemetry;
    const record = {
      type: 'rag_timing', interaction_id: interactionId, status,
      ...diagnostics, ...failure, had_first_text: telemetry.model_first_text_ms !== null,
      elapsed_ms: performance.now() - reqStart,
      error_categories: status === 'success' && !errors.length ? [] : [status === 'cancelled' ? 'cancelled' : 'request_failed']
    };
    setImmediate(() => console.info(JSON.stringify(record)));
  };

  try {

    const rawBody = await req.text();
    if (rawBody.length > 40000) throw new HttpError(413, 'Request is too large.');
    let input;
    try { input = parseChatInput(JSON.parse(rawBody)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid request.'); }
    const { projectId, organizationId, userQuery, boundedHistory, lastJiraTicketKey } = input;
    telemetry.request_parse_ms = performance.now() - reqStart;
    const authStart = performance.now();
    const { user, supabase, enterprise } = projectId
      ? await requireChatProject(projectId, req)
      : { ...await requireUser(req, 'enterprise'), enterprise: true };
    if (organizationId && !await getEnterpriseCopilotContext(supabase, organizationId)) {
      throw new HttpError(404, 'Organization not found.');
    }
    telemetry.auth_ms = performance.now() - authStart;
    const promptVariant = req.headers.get('x-prompt-variant') || input.promptVariant;
    isEvalMode = !input.wantsStream && (input.isEvalMode || req.headers.get('x-eval-mode') === 'true');
    telemetry.request_mode = isEvalMode ? 'json' : 'stream';
    const generationModelId = process.env.CHAT_MODEL || 'gemini-3.5-flash-lite';
    telemetry.model_id = /^gemini-[a-z0-9.-]+$/.test(generationModelId) ? generationModelId : null;
    const resolvedLastTicketKey = extractLatestJiraTicketKeyFromMessages(boundedHistory) ?? lastJiraTicketKey;
    const exactDeterministicIntent = getDeterministicIntent(userQuery);
    const decisionTokens: TokenCounts = { prompt: 0, completion: 0, total: 0 };
    const addDecisionTokens = (next?: TokenCounts) => {
      if (!next) return;
      decisionTokens.prompt += next.prompt;
      decisionTokens.completion += next.completion;
      decisionTokens.total += next.total;
      telemetry.token_usage = { ...decisionTokens };
      telemetry.tokens = { ...decisionTokens };
    };

    let jiraAccessChecked = false;
    let cachedJiraAccessAvailable = false;
    const getJiraAccess = async () => {
      if (!jiraAccessChecked) {
        jiraAccessChecked = true;
        cachedJiraAccessAvailable = await isJiraAccessAvailable(supabase, organizationId);
      }
      return enterprise ? cachedJiraAccessAvailable : false;
    };

    let toolDecision: AgentToolDecision;
    const initialAgentSteps = 1;
    let decisionMode: 'llm' | 'deterministic' = 'deterministic';
    let toolSelectionMs = 0;

    const permissionChange = requestsPermissionChange(userQuery);
    if (permissionChange) {
      toolDecision = { tool: 'deterministic_reply', intent: 'permission_refusal', requiresConfirmation: false };
    } else if (exactDeterministicIntent) {
      toolDecision = { tool: 'deterministic_reply', intent: exactDeterministicIntent, requiresConfirmation: false };
    } else {
      const jiraAccessAvailable = enterprise ? await getJiraAccess() : false;
      if (enterprise && !jiraAccessAvailable && draftJiraTicket(userQuery)) {
        toolDecision = { tool: 'jira_create_denied', requiresConfirmation: false };
      } else {
        stage = 'agent_decision';
        const llmSelection = await selectAgentToolWithLlm({
          modelId: generationModelId,
          userQuery,
          isEnterprise: enterprise,
          jiraAccessAvailable,
          lastJiraTicketKey: resolvedLastTicketKey,
          signal: req.signal,
          onRetry: () => { telemetry.retries.agent_decision++; },
        });
        toolDecision = llmSelection.decision;
        toolSelectionMs = llmSelection.decisionMs;
        decisionMode = 'llm';
        addDecisionTokens(llmSelection.tokens);
        telemetry.tool_selection_ms = Math.round(toolSelectionMs);
        telemetry.agent_decision_ms = Math.round(toolSelectionMs);
      }
    }

    const respondDirectToolReply = (
      responseText: string,
      agentTrace: AgentTrace,
      draft?: { summary: string; description: string },
    ) => {
      telemetry.retrieved_chunk_count = 0;
      telemetry.context_chars = 0;
      telemetry.agent = agentTrace;
      failure.retrieved_chunks_found = false;
      const directHeaders = {
        'Cache-Control': 'no-store',
        'x-rag-embedding-ms': '0',
        'x-rag-retrieval-ms': '0',
      };
      if (isEvalMode) {
        telemetry.ttft_ms = Math.round(performance.now() - reqStart);
        telemetry.total_ms = Math.round(performance.now() - reqStart);
        logTiming('success');
        return Response.json({
          text: responseText,
          output: responseText,
          context: '',
          citations: [],
          retrieved_chunks: [],
          ...(draft ? { jiraDraft: draft } : {}),
          metrics: telemetry,
        }, { headers: directHeaders });
      }
      const directStream = new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
        start(controller) {
          try {
            controller.enqueue(encodeEvent({
              type: 'agent_step',
              step: {
                phase: 'tool_selected',
                decisionMode: agentTrace.decision_mode,
                tool: agentTrace.tool,
              },
            }));
            controller.enqueue(encodeEvent({
              type: 'agent_step',
              step: {
                phase: 'final_decision',
                outcome: agentTrace.next_action,
                steps: agentTrace.steps,
                maxSteps: agentTrace.max_steps,
              },
            }));
            controller.enqueue(encodeEvent({ type: 'metadata', citations: [] }));
            telemetry.ttft_ms = Math.round(performance.now() - reqStart);
            telemetry.server_ttft_ms = performance.now() - reqStart;
            if (draft) controller.enqueue(encodeEvent({ type: 'jira_draft', draft }));
            controller.enqueue(encodeEvent({ type: 'text', text: responseText }));
            telemetry.total_ms = Math.round(performance.now() - reqStart);
            telemetry.server_finish_ready_ms = performance.now() - reqStart;
            controller.enqueue(encodeEvent({
              type: 'finish',
              metrics: telemetry,
              ...(req.headers.get('x-eval-mode') === 'true' ? { context: '' } : {}),
            }));
            controller.close();
            logTiming('success');
          } catch (error) {
            recordFailure('sse_emission', error);
            logTiming('error');
            throw error;
          }
        },
      });
      return new Response(directStream, {
        headers: { ...directHeaders, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' },
      });
    };

    if (toolDecision.tool === 'deterministic_reply') {
      const deterministicIntent = toolDecision.intent;
      const jiraEnabled = deterministicIntent === 'greeting' || permissionChange
        ? false
        : await getJiraAccess();
      const deterministicResponse = deterministicIntent === 'permission_refusal'
        ? (enterprise ? ENTERPRISE_NO_EVIDENCE : NO_EVIDENCE)
        : getDeterministicResponse(deterministicIntent, jiraEnabled);
      return respondDirectToolReply(deterministicResponse, {
        tool: 'deterministic_reply',
        steps: 2,
        max_steps: MAX_AGENT_STEPS,
        retrieval_attempts: 0,
        max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
        reformulated: false,
        evidence_sufficient: !permissionChange,
        evidence_reason: permissionChange ? 'permission_change_refused' : 'deterministic_short_circuit',
        decision_mode: decisionMode,
        next_action: 'tool_executed',
        decision_tokens: decisionTokens,
      });
    }

    if (toolDecision.tool === 'jira_status') {
      const statusResult = await lookupEnterpriseJiraStatus({
        supabase,
        organizationId,
        issueKey: toolDecision.issueKey,
      });
      return respondDirectToolReply(formatJiraStatusMessage(statusResult), {
        tool: 'jira_status',
        steps: 2,
        max_steps: MAX_AGENT_STEPS,
        retrieval_attempts: 0,
        max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
        reformulated: false,
        evidence_sufficient: true,
        evidence_reason: 'tool_executed',
        decision_mode: decisionMode,
        next_action: 'tool_executed',
        decision_tokens: decisionTokens,
      });
    }

    if (toolDecision.tool === 'jira_status_clarification') {
      return respondDirectToolReply(JIRA_STATUS_CLARIFICATION_PROMPT, {
        tool: 'jira_status_clarification',
        steps: 2,
        max_steps: MAX_AGENT_STEPS,
        retrieval_attempts: 0,
        max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
        reformulated: false,
        evidence_sufficient: true,
        evidence_reason: 'clarification_required',
        decision_mode: decisionMode,
        next_action: 'clarify',
        clarification_question: JIRA_STATUS_CLARIFICATION_PROMPT,
        decision_tokens: decisionTokens,
      });
    }

    if (toolDecision.tool === 'jira_create_denied' && enterprise) {
      return respondDirectToolReply(
        'Jira access is not enabled for this account.',
        {
          tool: 'jira_create_denied',
          steps: 2,
          max_steps: MAX_AGENT_STEPS,
          retrieval_attempts: 0,
          max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
          reformulated: false,
          evidence_sufficient: false,
          evidence_reason: 'jira_access_disabled',
          decision_mode: decisionMode,
          next_action: 'tool_executed',
          decision_tokens: decisionTokens,
        },
      );
    }

    if (toolDecision.tool === 'jira_create_draft' && enterprise) {
      if (await getJiraAccess()) {
        return respondDirectToolReply(
          'Please review and confirm the Jira ticket details below before creating it.',
          {
            tool: 'jira_create_draft',
            steps: 2,
            max_steps: MAX_AGENT_STEPS,
            retrieval_attempts: 0,
            max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
            reformulated: false,
            evidence_sufficient: true,
            evidence_reason: 'confirmation_required',
            decision_mode: decisionMode,
            next_action: 'confirmation_required',
            decision_tokens: decisionTokens,
          },
          toolDecision.draft,
        );
      }
      return respondDirectToolReply(
        'Jira access is not enabled for this account.',
        {
          tool: 'jira_create_denied',
          steps: 2,
          max_steps: MAX_AGENT_STEPS,
          retrieval_attempts: 0,
          max_retrieval_attempts: MAX_RETRIEVAL_ATTEMPTS,
          reformulated: false,
          evidence_sufficient: false,
          evidence_reason: 'jira_access_disabled',
          decision_mode: decisionMode,
          next_action: 'tool_executed',
          decision_tokens: decisionTokens,
        },
      );
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
    const maxEmbedRetries = 1;
    let totalEmbedMs = 0;
    let totalRetrievalMs = 0;

    const embedQuery = async (textToEmbed: string): Promise<number[]> => {
      const tEmbedStart = performance.now();
      let queryEmbedding: number[] | undefined;
      for (let attempt = 0; attempt <= maxEmbedRetries; attempt++) {
        try {
          const embedRes = await withTimeout(
            ai.models.embedContent({
              model: 'gemini-embedding-2',
              contents: textToEmbed,
              config: { outputDimensionality: 1536, abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]) },
            }),
            15000,
            'Gemini Embedding API'
          );
          queryEmbedding = embedRes.embeddings?.[0]?.values;
          if (queryEmbedding && queryEmbedding.length === 1536 && queryEmbedding.every(Number.isFinite)) {
            break;
          }
        } catch (err: unknown) {
          req.signal.throwIfAborted();
          if (attempt < maxEmbedRetries) {
            telemetry.retries.embedding++;
            if (isTransientGeminiError(err)) {
              await sleep(250, req.signal);
            }
          } else {
            telemetry.errors.push(`Embedding: ${errorMessage(err)}`);
            throw err;
          }
        }
      }
      totalEmbedMs += performance.now() - tEmbedStart;
      if (!queryEmbedding || queryEmbedding.length !== 1536 || !queryEmbedding.every(Number.isFinite)) {
        throw new Error('Failed to generate query embedding vector');
      }
      return queryEmbedding;
    };

    // Bounded single-agent loop (<= 2 retrieval attempts, <= 6 agent steps); RLS always applies.
    let evalDecisionMs = 0;
    const runRagOrchestration = async (
      loopSignal: AbortSignal,
      onStep?: (step: AgentStepEventData) => void,
    ) => {
      const { chunks: relevantChunks, agent: agentTrace, finalDecision } = await runBoundedRetrievalLoop({
        userQuery,
        initialQuery: toolDecision.tool === 'rag_retrieval' ? (toolDecision.searchQuery ?? userQuery) : userQuery,
        initialSteps: initialAgentSteps,
        retrieveForQuery: async (queryText) => {
          const queryEmbedding = await embedQuery(queryText);
          const tRetrievalStart = performance.now();
          const found = await retrieveVerifiedChunks(
            supabase,
            projectId,
            queryEmbedding,
            queryText,
            loopSignal,
            telemetry,
            enterprise,
            organizationId,
          );
          totalRetrievalMs += performance.now() - tRetrievalStart;
          return found;
        },
        decideAfterRetrieval: async ({ chunks, attempt, canRetry, previousQueries }) => {
          stage = 'agent_decision';
          const tEvalStart = performance.now();
          const ev = await evaluateEvidenceWithLlm({
            modelId: generationModelId,
            userQuery,
            chunks,
            attempt,
            canRetry,
            previousQueries,
            isEnterprise: enterprise,
            signal: loopSignal,
            onRetry: () => { telemetry.retries.agent_decision++; },
          });
          evalDecisionMs += performance.now() - tEvalStart;
          return ev;
        },
        onStep,
      });
      telemetry.embedding_ms = Math.round(totalEmbedMs);
      telemetry.retrieval_ms = Math.round(totalRetrievalMs);
      telemetry.tool_selection_ms = Math.round(toolSelectionMs);
      telemetry.evidence_eval_ms = Math.round(evalDecisionMs);
      telemetry.agent_decision_ms = Math.round(toolSelectionMs + evalDecisionMs);
      failure.evidence_quality = agentTrace.evidence_quality ?? null;
      failure.supporting_chunk_count = agentTrace.supporting_chunk_count ?? 0;
      addDecisionTokens(agentTrace.decision_tokens);
      agentTrace.steps = Math.min(agentTrace.steps + 1, MAX_AGENT_STEPS); // Final answer/refusal step
      agentTrace.decision_tokens = { ...decisionTokens };
      telemetry.agent = agentTrace;
      onStep?.({
        phase: 'final_decision',
        outcome: finalDecision.nextAction,
        steps: agentTrace.steps,
        maxSteps: agentTrace.max_steps,
      });

      const promptStart = performance.now();
      const contextBlock =
        relevantChunks.length > 0
          ? relevantChunks
            .map(
              (c, index: number) =>
                `### Document Context [Chunk ${index + 1} | ID: ${c.id}]\n${c.content}`
            )
            .join('\n\n')
          : 'NO_CONTEXT_FOUND';

      const baseSystemPrompt = getSystemPrompt(enterprise ? 'enterprise' : promptVariant, contextBlock);
      const supportingChunksHint = finalDecision.supportingChunkIndices && finalDecision.supportingChunkIndices.length > 0
        ? ` Focus on the confirmed details in ${finalDecision.supportingChunkIndices.map((idx) => `[Chunk ${idx}]`).join(', ')} where directly applicable.`
        : '';
      const systemPrompt = finalDecision.nextAction === 'clarify' && finalDecision.clarificationQuestion
        ? `${baseSystemPrompt}\n\n### CLARIFICATION GUIDANCE:\nThe retrieved context is partial.${supportingChunksHint} State only what is confirmed in RETRIEVED CONTEXT using valid [Chunk <number>] citations, do not invent missing facts or speculate about unavailable documents, and ask this concise clarifying question: ${finalDecision.clarificationQuestion} If RETRIEVED CONTEXT does not actually substantiate any relevant facts for the clarifying context, reply with the exact refusal sentence instead.`
        : baseSystemPrompt;
      const refusalText = enterprise ? ENTERPRISE_NO_EVIDENCE : NO_EVIDENCE;
      // Previous enterprise answers may contain evidence whose grants have since expired.
      const messages = enterprise ? [{ role: 'user' as const, content: userQuery }] : boundedHistory;
      telemetry.retrieved_chunk_count = relevantChunks.length;
      failure.retrieved_chunks_found = relevantChunks.length > 0;
      const shouldGenerateAnswer = relevantChunks.length > 0 && finalDecision.nextAction !== 'abstain';

      let citations = relevantChunks.map((c, index: number) => ({
        id: c.id,
        index: index + 1,
        content: c.content?.slice(0, 300) || '',
        metadata: c.metadata || {},
      }));

      let contextString = relevantChunks.map((c, i: number) => `[Chunk ${i + 1}]: ${c.content}`).join('\n\n');
      const isEnterpriseRefusal = (value: string) => {
        const trimmed = value.trim();
        return isNoEvidenceAnswer(trimmed)
          || /^I don't know(?:\s+based on the documents I can access)?\.?(?:\s*\[Chunk[^\]]*\])*\s*$/i.test(trimmed);
      };
      const classifyEvaluatorAbstention = (): AbstentionReason => {
        if (!relevantChunks.length) return 'no_chunks_retrieved';
        if (finalDecision.clampedFrom === 'answer') return 'unsupported_evaluator_answer';
        if (finalDecision.reason === 'no_new_evidence_on_retry') return 'no_new_evidence_on_retry';
        if (finalDecision.evidenceQuality === 'topical_only') return 'topical_only_evidence';
        return 'insufficient_evidence';
      };
      const prepareEnterpriseAnswer = async (text: string, finishReason: string, signal: AbortSignal) => {
        if (!enterprise) return text;
        if (!relevantChunks.length) {
          failure.enterprise_rejection_reason = 'no_retrieved_chunks';
          citations = [];
          contextString = '';
          return ENTERPRISE_NO_EVIDENCE;
        }
        if (!shouldGenerateAnswer) {
          failure.model_refusal = false;
          failure.enterprise_rejection_reason = 'evaluator_abstained';
          citations = [];
          contextString = '';
          return ENTERPRISE_NO_EVIDENCE;
        }
        if (finishReason !== 'stop') {
          failure.enterprise_rejection_reason = 'incomplete_finish_reason';
          return text;
        }
        const refused = isEnterpriseRefusal(text);
        const tooLong = text.length > MAX_ANSWER_CHARS;
        const citationsValid = !refused && !tooLong && validCitations(text, citations);
        failure.model_refusal = refused;
        failure.answer_length_failed = !refused && tooLong;
        failure.citation_validation_failed = !refused && !tooLong && !citationsValid;
        if (!refused && !tooLong && citationsValid) {
          const chunkIds = relevantChunks.map(chunk => chunk.id);
          const visibility = organizationId
            ? supabase.rpc('enterprise_chunks_still_visible', { target_organization_id: organizationId, chunk_ids: chunkIds })
            : supabase.rpc('rag_chunks_still_visible', { target_project_id: projectId, chunk_ids: chunkIds });
          const { data, error } = await withTimeout(Promise.resolve(
            visibility.abortSignal(AbortSignal.any([signal, AbortSignal.timeout(5000)])),
          ), 5000, 'Evidence authorization');
          signal.throwIfAborted();
          if (error) throw new Error('Unable to verify evidence authorization.');
          if (data === true) {
            failure.enterprise_rejection_reason = 'none';
            const cited = new Set(citationIndices(text));
            citations = citations.filter(citation => cited.has(citation.index));
            return text;
          }
          failure.visibility_recheck_failed = true;
          failure.enterprise_rejection_reason = 'visibility_recheck_failed';
        } else {
          failure.enterprise_rejection_reason = refused
            ? 'model_refusal'
            : tooLong
              ? 'answer_length_exceeded'
              : 'invalid_citations';
        }
        citations = [];
        contextString = '';
        return ENTERPRISE_NO_EVIDENCE;
      };

      const recordFinalOutcome = (finalText: string) => {
        const finalAbstained = isNoEvidenceAnswer(finalText);
        const disagreement = shouldGenerateAnswer && finalAbstained;
        let abstentionReason: AbstentionReason = 'none';
        if (finalAbstained) {
          if (!shouldGenerateAnswer) {
            abstentionReason = classifyEvaluatorAbstention();
          } else if (failure.model_refusal) {
            abstentionReason = 'generator_refusal';
          } else if (enterprise && failure.enterprise_rejection_reason === 'invalid_citations') {
            abstentionReason = 'invalid_citations';
          } else if (enterprise && failure.enterprise_rejection_reason === 'answer_length_exceeded') {
            abstentionReason = 'answer_length_exceeded';
          } else if (enterprise && failure.enterprise_rejection_reason === 'visibility_recheck_failed') {
            abstentionReason = 'visibility_recheck_failed';
          } else {
            abstentionReason = 'generator_refusal';
          }
        }
        failure.evaluator_generator_disagreement = disagreement;
        failure.abstention_reason = abstentionReason;
        agentTrace.final_outcome = finalAbstained ? 'abstain' : finalDecision.nextAction;
        agentTrace.evaluator_generator_disagreement = disagreement;
        agentTrace.abstention_reason = abstentionReason;
      };

      const finalizeAnswer = async (text: string, finishReason: string, signal = req.signal) => {
        stage = 'answer_validation';
        if (!enterprise && relevantChunks.length > 0 && shouldGenerateAnswer) {
          failure.model_refusal = isNoEvidenceAnswer(text);
        }
        try {
          assertValidAnswer(text, citations, finishReason);
        } catch (error) {
          if (!enterprise) {
            failure.answer_length_failed = finishReason === 'stop' && text.length > MAX_ANSWER_CHARS;
            failure.citation_validation_failed = finishReason === 'stop'
              && error instanceof Error
              && error.message === 'Answer contains missing or invalid citations.';
          }
          recordFailure(stage, error, finishReason !== 'stop' ? 'generation_incomplete'
            : !text.trim() ? 'answer_empty' : text.length > MAX_ANSWER_CHARS ? 'answer_too_long'
              : error instanceof Error && error.message === 'Answer contains missing or invalid citations.'
                ? 'invalid_citations' : 'unknown_error');
          throw error;
        }
        telemetry.generation_ms = Math.round(performance.now() - generationStart);
        telemetry.total_ms = Math.round(performance.now() - reqStart);
        if (enterprise || !projectId) {
          signal.throwIfAborted();
          return;
        }
        const writeStart = performance.now();
        stage = 'interaction_persistence';
        const writeAbort = new AbortController();
        let rejectCancellation!: (reason: unknown) => void;
        const onAbort = () => {
          writeAbort.abort(signal.reason);
          rejectCancellation(signal.reason);
        };
        try {
          signal.throwIfAborted();
          const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
          signal.addEventListener('abort', onAbort, { once: true });
          failure.interaction_write_started = true;
          const { error } = await withTimeout(Promise.race([
            Promise.resolve(createAdminClient(enterprise ? 'enterprise' : 'personal').from('interactions').insert({
              id: interactionId, project_id: projectId.trim(), query_text: userQuery,
              user_id: user.id,
              retrieved_chunk_ids: relevantChunks.map((c) => c.id),
              response_markdown: text, latency_ms: telemetry.total_ms,
            }).abortSignal(writeAbort.signal).retry(false)),
            cancellation,
          ]), 5000, 'Interaction persistence');
          signal.throwIfAborted();
          if (error) throw new Error('Unable to save interaction.');
        } catch (error) {
          writeAbort.abort(error);
          recordFailure(stage, error, signal.aborted ? 'request_cancelled' : 'interaction_write_failed');
          throw error;
        } finally {
          signal.removeEventListener('abort', onAbort);
          telemetry.interaction_write_ms = performance.now() - writeStart;
        }
      };

      telemetry.context_chars = contextBlock.length;
      telemetry.prompt_build_ms = performance.now() - promptStart;
      const updateUsage = (u: LanguageModelUsage) => {
        telemetry.token_usage = {
          prompt: decisionTokens.prompt + (u.inputTokens ?? 0),
          completion: decisionTokens.completion + (u.outputTokens ?? 0),
          total: decisionTokens.total + (u.totalTokens ?? 0),
        };
        telemetry.tokens = { ...telemetry.token_usage };
      };
      const generationStart = performance.now();
      const fallbackQuestionsFor = (text: string, signal: AbortSignal) =>
        organizationId && text === ENTERPRISE_NO_EVIDENCE
          ? getEnterpriseFallbackQuestions(supabase, organizationId, signal)
          : [];

      return {
        agentTrace,
        finalDecision,
        systemPrompt,
        refusalText,
        messages,
        getCitations: () => citations,
        getContextString: () => contextString,
        prepareEnterpriseAnswer,
        finalizeAnswer,
        recordFinalOutcome,
        fallbackQuestionsFor,
        shouldGenerateAnswer,
        updateUsage,
      };
    };

    const headers = {
      'Cache-Control': 'no-store',
      ...(!enterprise ? { 'x-interaction-id': interactionId } : {}),
    };

    if (isEvalMode) {
      const rag = await runRagOrchestration(req.signal);
      let text = rag.refusalText;
      let finishReason = 'stop';
      if (rag.shouldGenerateAnswer) {
        const { result } = await withTransientGeminiRetry(
          (attemptSignal) =>
            generateText({
              model: google(generationModelId), system: rag.systemPrompt, messages: rag.messages,
              maxOutputTokens: 1000, maxRetries: 0, abortSignal: attemptSignal,
            }),
          {
            signal: req.signal, maxAttempts: 2, attemptTimeoutMs: 25000, totalTimeoutMs: 35000,
            onRetry: () => { telemetry.retries.generation++; },
            shouldRetryResult: (res) => isAbnormalIncompleteFinish(res.finishReason),
          },
        );
        text = result.text;
        finishReason = result.finishReason;
        failure.model_finish_reason = finishReason;
        rag.updateUsage(result.usage);
      }
      text = await rag.prepareEnterpriseAnswer(text, finishReason, req.signal);
      await rag.finalizeAnswer(text, finishReason);
      rag.recordFinalOutcome(text);
      const fallbackQuestions = await rag.fallbackQuestionsFor(text, req.signal);
      logTiming('success');
      const finalCitations = rag.getCitations();
      return Response.json({
        text, output: text, context: rag.getContextString(), citations: finalCitations,
        ...(fallbackQuestions.length ? { fallbackQuestions } : {}),
        retrieved_chunks: finalCitations.map(c => ({ id: c.id, index: c.index })),
        ...(!enterprise ? { interactionId } : {}), metrics: telemetry
      }, {
        headers: {
          ...headers,
          'x-rag-embedding-ms': String(telemetry.embedding_ms),
          'x-rag-retrieval-ms': String(telemetry.retrieval_ms),
        },
      });
    }

    const streamAbort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; streamAbort.abort(); },
      async start(controller) {
        const send = (event: ChatEvent) => {
          if (cancelled) return;
          if (event.type === 'text' && event.text && telemetry.server_ttft_ms === null) {
            telemetry.server_ttft_ms = performance.now() - reqStart;
          }
          try {
            controller.enqueue(encodeEvent(event));
          } catch (error) {
            recordFailure('sse_emission', error);
            throw error;
          }
        };
        let succeeded = false;
        try {
          send({
            type: 'agent_step',
            step: {
              phase: 'tool_selected',
              decisionMode,
              tool: 'rag_retrieval',
            },
          });
          const rag = await runRagOrchestration(
            AbortSignal.any([req.signal, streamAbort.signal]),
            (step) => send({ type: 'agent_step', step }),
          );
          stage = 'stream_initialization';
          if (!enterprise) send({ type: 'metadata', interactionId, citations: rag.getCitations() });
          let text = '';
          let emittedLength = 0;
          let finishReason = 'stop';
          if (!rag.shouldGenerateAnswer) {
            text = rag.refusalText;
            telemetry.ttft_ms = Math.round(performance.now() - reqStart);
            if (!enterprise) {
              send({ type: 'text', text });
              emittedLength = text.length;
            }
          } else {
            const modelStart = performance.now();
            stage = 'stream_initialization';
            generationDeadline = AbortSignal.timeout(35000);
            generationSignal = AbortSignal.any([req.signal, streamAbort.signal, generationDeadline]);
            let modelStreamErrored = false;
            const maxStreamAttempts = 2; // Bounded pre-emission retry; never replay already-emitted text.
            const retryStreamAttempt = async (retryErr: unknown, streamAttempt: number) => {
              telemetry.retries.generation++;
              text = '';
              telemetry.model_first_text_ms = null;
              telemetry.ttft_ms = 0;
              await sleep(getTransientGeminiRetryDelayMs(retryErr, streamAttempt), generationSignal!);
            };
            for (let streamAttempt = 1; streamAttempt <= maxStreamAttempts; streamAttempt++) {
              let attemptSawError = false;
              let attemptError: unknown = null;
              stage = 'stream_initialization';
              try {
                const result = streamText({
                  model: google(generationModelId), system: rag.systemPrompt, messages: rag.messages,
                  maxOutputTokens: 1000, maxRetries: 0,
                  abortSignal: generationSignal,
                  // The SDK filters error parts out of textStream; retain their origin without raw logging.
                  onError: ({ error }) => {
                    attemptSawError = true;
                    attemptError = error;
                  },
                });
                stage = 'model_stream_iteration';
                for await (const delta of result.textStream) {
                  if (text.length + delta.length > MAX_ANSWER_CHARS) {
                    failure.answer_length_failed = true;
                    if (enterprise) failure.enterprise_rejection_reason = 'answer_length_exceeded';
                    recordFailure('answer_validation', undefined, 'answer_too_long');
                    streamAbort.abort();
                    throw new Error('Answer exceeds the length limit.');
                  }
                  if (!delta) continue;
                  if (!text) {
                    const firstText = performance.now();
                    telemetry.ttft_ms = Math.round(firstText - reqStart);
                    telemetry.model_first_text_ms = firstText - modelStart;
                  }
                  text += delta;
                  if (!enterprise) {
                    const publishable = safeCitationPrefix(text, rag.getCitations());
                    if (publishable.length > emittedLength) {
                      send({ type: 'text', text: publishable.slice(emittedLength) });
                      emittedLength = publishable.length;
                    }
                  }
                }
                if (attemptSawError && emittedLength === 0 && streamAttempt < maxStreamAttempts && !generationSignal.aborted && isTransientGeminiError(attemptError)) {
                  await retryStreamAttempt(attemptError, streamAttempt);
                  continue;
                }
                if (attemptSawError) {
                  modelStreamErrored = true;
                  recordFailure('model_stream_iteration', attemptError);
                  stage = 'model_stream_finalization';
                  rag.updateUsage(await result.usage);
                  finishReason = await result.finishReason;
                  failure.model_finish_reason = finishReason;
                  failure.model_stream_completed = false;
                  break;
                }
                stage = 'model_stream_finalization';
                const attemptUsage = await result.usage;
                const attemptFinishReason = await result.finishReason;
                const incompleteFinish = isAbnormalIncompleteFinish(attemptFinishReason);
                if (incompleteFinish && emittedLength === 0 && streamAttempt < maxStreamAttempts && !generationSignal.aborted) {
                  await retryStreamAttempt(null, streamAttempt);
                  continue;
                }
                if (incompleteFinish) {
                  modelStreamErrored = true;
                }
                rag.updateUsage(attemptUsage);
                finishReason = attemptFinishReason;
                failure.model_finish_reason = finishReason;
                failure.model_stream_completed = !modelStreamErrored && !generationSignal.aborted;
                break;
              } catch (error) {
                const retryErr = attemptError ?? error;
                if (emittedLength === 0 && streamAttempt < maxStreamAttempts && !generationSignal.aborted && isTransientGeminiError(retryErr)) {
                  await retryStreamAttempt(retryErr, streamAttempt);
                  continue;
                }
                if (attemptSawError && !generationSignal.aborted) {
                  recordFailure('model_stream_iteration', attemptError);
                }
                throw error;
              }
            }
          }
          const signal = AbortSignal.any([req.signal, streamAbort.signal]);
          text = await rag.prepareEnterpriseAnswer(text, finishReason, signal);
          await rag.finalizeAnswer(text, finishReason, signal);
          rag.recordFinalOutcome(text);
          const fallbackQuestions = await rag.fallbackQuestionsFor(text, signal);
          if (enterprise) send({ type: 'metadata', citations: rag.getCitations() });
          if (text.length > emittedLength) send({ type: 'text', text: text.slice(emittedLength) });
          if (!cancelled) telemetry.server_finish_ready_ms = performance.now() - reqStart;
          send({
            type: 'finish', metrics: telemetry,
            ...(fallbackQuestions.length ? { fallbackQuestions } : {}),
            ...(req.headers.get('x-eval-mode') === 'true' ? { context: rag.getContextString() } : {})
          });
          succeeded = true;
        } catch (error) {
          recordFailure(stage, error);
          send({ type: 'error', message: 'The answer could not be completed. Please retry.' });
        } finally {
          try {
            if (!cancelled) controller.close();
          } catch (error) {
            recordFailure('sse_emission', error);
            throw error;
          } finally {
            if ((cancelled || req.signal.aborted) && failure.failure_stage === null) recordFailure(stage, undefined, 'request_cancelled');
            logTiming(cancelled || req.signal.aborted ? 'cancelled' : succeeded && failure.failure_stage === null ? 'success' : 'error');
          }
        }
      },
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } });
  } catch (error) {
    recordFailure(stage, error);
    logTiming(req.signal.aborted ? 'cancelled' : 'error');
    return error instanceof HttpError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: 'The request could not be completed.' }, { status: 500 });
  }
}
