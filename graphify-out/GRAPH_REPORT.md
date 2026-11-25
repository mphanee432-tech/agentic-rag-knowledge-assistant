# Graph Report - Agentic-rag-knowledge-assistant  (2026-11-25)

## Corpus Check
- 84 files · ~42,910 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 644 nodes · 1645 edges · 26 communities (24 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6fceca85`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- chat/route.ts
- Project Dialogs and Controls
- next.config.ts
- config.ts
- Prompt Evaluation Configuration
- Component Library Configuration
- llm-agent.ts
- TypeScript Compiler Configuration
- dependencies
- chat/route.ts
- Development and Evaluation Dependencies
- Project Commands
- agent-loop.ts
- Workspace Build Permissions
- Lint Configuration
- Tailwind Theme Configuration
- message-item.tsx
- ingest/route.ts
- eval-dataset.ts
- chat-container.tsx
- systemPrompt.ts
- login/page.tsx
- chat-input.ts
- retrieve-chunks.ts
- package.json
- @types/react@^19

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 41 edges
2. `requireUser()` - 38 edges
3. `Button()` - 37 edges
4. `POST()` - 34 edges
5. `react` - 30 edges
6. `ProjectCard()` - 27 edges
7. `apiError()` - 26 edges
8. `ChatContainer()` - 22 edges
9. `lucide-react` - 19 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `lookupEnterpriseJiraStatus()`  [EXTRACTED]
  app/api/chat/route.ts → lib/jira-status.ts
- `ChatContainer()` --calls--> `formatJiraStatusMessage()`  [EXTRACTED]
  components/chat/chat-container.tsx → lib/jira-ticket.ts
- `ChatContainer()` --calls--> `extractLatestJiraTicketKeyFromMessages()`  [EXTRACTED]
  components/chat/chat-container.tsx → lib/jira-ticket.ts
- `POST()` --calls--> `selectAgentToolWithLlm()`  [EXTRACTED]
  app/api/chat/route.ts → lib/llm-agent.ts
- `POST()` --calls--> `evaluateEvidenceWithLlm()`  [EXTRACTED]
  app/api/chat/route.ts → lib/llm-agent.ts

## Import Cycles
- None detected.

## Communities (26 total, 2 thin omitted)

### Community 0 - "chat/route.ts"
Cohesion: 0.13
Nodes (27): EnterpriseRejectionReason, errorMessage(), FailureCategory, FailureStage, POST(), runtime, sanitizeProviderError(), AgentStepEventData (+19 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.06
Nodes (61): createProject(), createProjectAction, deleteProject(), renameProject(), DashboardPage(), DashboardPageProps, RawProjectRecord, CitationBadge() (+53 more)

### Community 2 - "next.config.ts"
Cohesion: 0.33
Nodes (3): nextConfig, dotenv@^18.0.8, dotenv

### Community 3 - "config.ts"
Cohesion: 0.11
Nodes (41): signOut(), RecoveryStatus, ResetPasswordForm(), handleSubmit(), verifyRecoverySession(), ResetPasswordPage(), ChatSessionBoundary(), getActivePageWorkspace() (+33 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "llm-agent.ts"
Cohesion: 0.15
Nodes (17): AgentToolDecision, EvidenceDecision, eligibleConversation(), AGENT_DECISION_ATTEMPT_TIMEOUT_MS, AGENT_DECISION_MAX_ATTEMPTS, AGENT_DECISION_TOTAL_TIMEOUT_MS, asTrimmedString(), evaluateEvidenceWithLlm() (+9 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.11
Nodes (18): dependencies, class-variance-authority@^0.7.1, cn@^0.4.0, @google/genai@^2.30.0, lucide-react@^1.58.0, next@16.4.6, pdf-lib@^1.17.1, radix-ui@^1.8.1 (+10 more)

### Community 9 - "chat/route.ts"
Cohesion: 0.08
Nodes (60): DELETE(), GET(), POST(), GET(), GET(), GET(), POST(), POST() (+52 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.12
Nodes (17): devDependencies, promptfoo@^0.124.1, supabase@^3.0.0, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react-dom@^19 (+9 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "agent-loop.ts"
Cohesion: 0.12
Nodes (26): AbstentionReason, addTokens(), AgentRetrievalStep, AgentTrace, clampEvidenceDecision(), DOMAIN_EXPANSIONS, evaluateRetrievedEvidence(), EvidenceEvaluation (+18 more)

### Community 13 - "Workspace Build Permissions"
Cohesion: 0.25
Nodes (7): allowBuilds, esbuild, @google/genai, protobufjs, sharp, supabase, unrs-resolver

### Community 14 - "Lint Configuration"
Cohesion: 0.33
Nodes (5): eslintConfig, eslint@^9, eslint-config-next@16.4.6, eslint, eslint-config-next

### Community 15 - "Tailwind Theme Configuration"
Cohesion: 0.50
Nodes (3): tailwindcss@^4, tailwindcss, config

### Community 16 - "message-item.tsx"
Cohesion: 0.17
Nodes (16): ChatMessagesProps, ISSUE_TAGS, MessageActions(), MessageActionsProps, AgentActivityPanel(), AgentActivityRows(), EVIDENCE_DECISION_LABELS, FormattedContent() (+8 more)

### Community 17 - "ingest/route.ts"
Cohesion: 0.14
Nodes (29): InvalidDocumentError, maxDuration, POST(), runtime, InvalidDocumentError, maxDuration, POST(), runtime (+21 more)

### Community 19 - "chat-container.tsx"
Cohesion: 0.07
Nodes (55): AccountSummary(), AccountSummaryProps, ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, ChatMessages(), CitationBadgeProps (+47 more)

### Community 20 - "systemPrompt.ts"
Cohesion: 0.53
Nodes (5): buildBaselinePrompt(), buildEnterprisePolicyPrompt(), buildStrictCitationPrompt(), getSystemPrompt(), PromptVariant

### Community 21 - "login/page.tsx"
Cohesion: 0.10
Nodes (29): geistMono, geistSans, inter, metadata, RootLayout(), clearPendingDepartmentCookie(), completeDemoOnboarding(), getPendingDepartmentCookie() (+21 more)

### Community 22 - "chat-input.ts"
Cohesion: 0.15
Nodes (9): CAPABILITY_RESPONSE_WITH_JIRA, CAPABILITY_RESPONSE_WITHOUT_JIRA, ChatMessageInput, DeterministicIntent, getDeterministicResponse(), GREETING_RESPONSE, IDENTITY_RESPONSE_WITH_JIRA, IDENTITY_RESPONSE_WITHOUT_JIRA (+1 more)

### Community 23 - "retrieve-chunks.ts"
Cohesion: 0.43
Nodes (5): PERSONAL_SPARSE_STOPWORDS, RagChunk, retrieveVerifiedChunks(), toPersonalSparseQueryText(), withTimeout()

### Community 24 - "package.json"
Cohesion: 0.15
Nodes (12): clsx@^2.1.1, react-markdown@10.1.0, shadcn@^4.21.5, @supabase/supabase-js@^2.118.0, name, packageManager, private, version (+4 more)

## Knowledge Gaps
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Project Dialogs and Controls` to `config.ts`, `dependencies`, `message-item.tsx`, `chat-container.tsx`, `login/page.tsx`, `package.json`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Should `chat/route.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Project Dialogs and Controls` to `next.config.ts`, `config.ts`, `dependencies`, `chat/route.ts`, `chat-container.tsx`, `login/page.tsx`, `package.json`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.059025394646533974 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Should `config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1099290780141844 - nodes in this community are weakly interconnected._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._