# Graph Report - Agentic-rag-knowledge-assistant  (2026-11-25)

## Corpus Check
- 84 files · ~43,329 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 646 nodes · 1651 edges · 27 communities (25 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `37f7298d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app/page.tsx
- Project Dialogs and Controls
- next.config.ts
- config.ts
- Prompt Evaluation Configuration
- Component Library Configuration
- jira-ticket.ts
- TypeScript Compiler Configuration
- dependencies
- chat/route.ts
- Development and Evaluation Dependencies
- Project Commands
- agent-loop.ts
- Workspace Build Permissions
- Lint Configuration
- Tailwind Theme Configuration
- package.json
- ingest/route.ts
- eval-dataset.ts
- chat-container.tsx
- systemPrompt.ts
- next-themes
- react-dom
- tw-animate-css@^1.4.0
- package.json
- splitter.ts
- @types/react-dom@^19

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 41 edges
2. `requireUser()` - 38 edges
3. `Button()` - 37 edges
4. `POST()` - 36 edges
5. `react` - 30 edges
6. `ProjectCard()` - 27 edges
7. `apiError()` - 26 edges
8. `ChatContainer()` - 22 edges
9. `lucide-react` - 19 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `runBoundedRetrievalLoop()`  [EXTRACTED]
  app/api/chat/route.ts → lib/agent-loop.ts
- `POST()` --calls--> `getEnterpriseCopilotContext()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `HttpError`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `isJiraAccessAvailable()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireChatProject()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts

## Import Cycles
- None detected.

## Communities (27 total, 2 thin omitted)

### Community 0 - "app/page.tsx"
Cohesion: 0.14
Nodes (26): EnterpriseRejectionReason, errorMessage(), FailureCategory, FailureStage, isAbnormalIncompleteFinish(), POST(), runtime, sanitizeProviderError() (+18 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.05
Nodes (67): createProject(), createProjectAction, deleteProject(), renameProject(), DashboardPage(), DashboardPageProps, RawProjectRecord, ChatInputProps (+59 more)

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

### Community 6 - "jira-ticket.ts"
Cohesion: 0.13
Nodes (18): AgentToolDecision, EvidenceDecision, EvidenceQuality, TokenCounts, JIRA_DESCRIPTION_MAX, JIRA_SUMMARY_MAX, AGENT_DECISION_ATTEMPT_TIMEOUT_MS, AGENT_DECISION_MAX_ATTEMPTS (+10 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, class-variance-authority@^0.7.1, cn@^0.4.0, @google/genai@^2.30.0, lucide-react@^1.58.0, next@16.4.6, pdf-lib@^1.17.1, radix-ui@^1.8.1 (+11 more)

### Community 9 - "chat/route.ts"
Cohesion: 0.10
Nodes (49): DELETE(), GET(), POST(), GET(), GET(), GET(), POST(), POST() (+41 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.12
Nodes (17): devDependencies, promptfoo@^0.124.1, supabase@^3.0.0, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react@^19 (+9 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "agent-loop.ts"
Cohesion: 0.14
Nodes (23): AbstentionReason, addTokens(), AgentRetrievalStep, AgentTrace, clampEvidenceDecision(), DOMAIN_EXPANSIONS, evaluateRetrievedEvidence(), EvidenceEvaluation (+15 more)

### Community 13 - "Workspace Build Permissions"
Cohesion: 0.25
Nodes (7): allowBuilds, esbuild, @google/genai, protobufjs, sharp, supabase, unrs-resolver

### Community 14 - "Lint Configuration"
Cohesion: 0.33
Nodes (5): eslintConfig, eslint@^9, eslint-config-next@16.4.6, eslint, eslint-config-next

### Community 15 - "Tailwind Theme Configuration"
Cohesion: 0.50
Nodes (3): tailwindcss@^4, tailwindcss, config

### Community 16 - "package.json"
Cohesion: 0.17
Nodes (16): ChatMessagesProps, ISSUE_TAGS, MessageActions(), MessageActionsProps, AgentActivityPanel(), AgentActivityRows(), EVIDENCE_DECISION_LABELS, FormattedContent() (+8 more)

### Community 17 - "ingest/route.ts"
Cohesion: 0.19
Nodes (23): InvalidDocumentError, maxDuration, POST(), runtime, InvalidDocumentError, maxDuration, POST(), runtime (+15 more)

### Community 19 - "chat-container.tsx"
Cohesion: 0.06
Nodes (61): AccountSummary(), AccountSummaryProps, ChatContainer(), ChatContainerProps, ChatInput(), ChatMessages(), CitationBadgeProps, ProjectWorkspaceClient() (+53 more)

### Community 20 - "systemPrompt.ts"
Cohesion: 0.53
Nodes (5): buildBaselinePrompt(), buildEnterprisePolicyPrompt(), buildStrictCitationPrompt(), getSystemPrompt(), PromptVariant

### Community 21 - "next-themes"
Cohesion: 0.10
Nodes (29): geistMono, geistSans, inter, metadata, RootLayout(), clearPendingDepartmentCookie(), completeDemoOnboarding(), getPendingDepartmentCookie() (+21 more)

### Community 22 - "react-dom"
Cohesion: 0.14
Nodes (11): CAPABILITY_RESPONSE_WITH_JIRA, CAPABILITY_RESPONSE_WITHOUT_JIRA, ChatMessageInput, DeterministicIntent, eligibleConversation(), getDeterministicIntent(), getDeterministicResponse(), GREETING_RESPONSE (+3 more)

### Community 23 - "tw-animate-css@^1.4.0"
Cohesion: 0.31
Nodes (7): PERSONAL_SPARSE_STOPWORDS, RagChunk, retrieveVerifiedChunks(), toPersonalSparseQueryText(), withTimeout(), @supabase/supabase-js@^2.118.0, @supabase/supabase-js

### Community 24 - "package.json"
Cohesion: 0.18
Nodes (10): ai@^7.0.142, remark-gfm@4.0.1, tailwind-merge@^3.7.0, name, packageManager, private, version, ai (+2 more)

### Community 25 - "splitter.ts"
Cohesion: 0.36
Nodes (7): checkIsTabular(), ChunkMetadata, DocumentChunk, estimateTokens(), MarkdownBlock, parseBlocks(), splitMarkdown()

## Knowledge Gaps
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Project Dialogs and Controls` to `config.ts`, `dependencies`, `package.json`, `chat-container.tsx`, `next-themes`, `package.json`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Should `app/page.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13793103448275862 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Project Dialogs and Controls` to `next.config.ts`, `config.ts`, `dependencies`, `chat/route.ts`, `chat-container.tsx`, `next-themes`, `package.json`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.05319355464958261 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Should `config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1099290780141844 - nodes in this community are weakly interconnected._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._