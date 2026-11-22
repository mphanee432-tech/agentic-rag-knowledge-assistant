# Graph Report - Agentic-rag-knowledge-assistant  (2026-11-22)

## Corpus Check
- 83 files · ~35,866 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 590 nodes · 1507 edges · 24 communities (20 shown, 4 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `52273206`
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

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 41 edges
2. `Button()` - 37 edges
3. `requireUser()` - 36 edges
4. `react` - 30 edges
5. `ProjectCard()` - 27 edges
6. `POST()` - 26 edges
7. `apiError()` - 26 edges
8. `ChatContainer()` - 22 edges
9. `lucide-react` - 19 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `runBoundedRetrievalLoop()`  [EXTRACTED]
  app/api/chat/route.ts → lib/agent-loop.ts
- `POST()` --calls--> `selectAgentTool()`  [EXTRACTED]
  app/api/chat/route.ts → lib/agent-loop.ts
- `POST()` --calls--> `extractLatestJiraTicketKeyFromMessages()`  [EXTRACTED]
  app/api/chat/route.ts → lib/jira-ticket.ts
- `POST()` --calls--> `formatJiraStatusMessage()`  [EXTRACTED]
  app/api/chat/route.ts → lib/jira-ticket.ts
- `POST()` --calls--> `getSystemPrompt()`  [EXTRACTED]
  app/api/chat/route.ts → lib/prompts/systemPrompt.ts

## Import Cycles
- None detected.

## Communities (24 total, 4 thin omitted)

### Community 0 - "app/page.tsx"
Cohesion: 0.17
Nodes (19): DashboardPage(), DashboardPageProps, RawProjectRecord, ProjectPageProps, ProjectWorkspacePage(), ProjectWorkspaceClient(), ProjectCardData, TAB_ITEMS (+11 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.07
Nodes (40): createProject(), createProjectAction, deleteProject(), renameProject(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard(), ProjectCardProps (+32 more)

### Community 2 - "next.config.ts"
Cohesion: 0.33
Nodes (3): nextConfig, dotenv@^18.0.8, dotenv

### Community 3 - "config.ts"
Cohesion: 0.06
Nodes (66): signOut(), geistMono, geistSans, inter, metadata, RootLayout(), clearPendingDepartmentCookie(), completeDemoOnboarding() (+58 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "jira-ticket.ts"
Cohesion: 0.14
Nodes (25): JiraTicketDraftFormProps, asNonEmptyString(), asRecord(), fetchLiveJiraOptions(), normalizeAssignees(), normalizeIssueTypes(), normalizePriorities(), normalizeProjects() (+17 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.10
Nodes (21): dependencies, ai@^7.0.142, class-variance-authority@^0.7.1, cn@^0.4.0, @google/genai@^2.30.0, lucide-react@^1.58.0, next@16.4.6, pdf-lib@^1.17.1 (+13 more)

### Community 9 - "chat/route.ts"
Cohesion: 0.09
Nodes (52): EnterpriseRejectionReason, errorMessage(), FailureCategory, FailureStage, POST(), runtime, sanitizeProviderError(), DELETE() (+44 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.12
Nodes (17): devDependencies, supabase@^3.0.0, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react@^19, @types/react-dom@^19 (+9 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "agent-loop.ts"
Cohesion: 0.09
Nodes (28): AgentTool, AgentToolDecision, AgentTrace, DOMAIN_EXPANSIONS, evaluateRetrievedEvidence(), EvidenceEvaluation, extractSalientKeywords(), JiraTicketDraft (+20 more)

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
Cohesion: 0.15
Nodes (12): @ai-sdk/google@^4.0.98, clsx@^2.1.1, tailwind-merge@^3.7.0, promptfoo@^0.124.1, name, packageManager, private, version (+4 more)

### Community 17 - "ingest/route.ts"
Cohesion: 0.16
Nodes (25): InvalidDocumentError, maxDuration, POST(), runtime, InvalidDocumentError, maxDuration, POST(), runtime (+17 more)

### Community 19 - "chat-container.tsx"
Cohesion: 0.07
Nodes (62): AccountSummary(), AccountSummaryProps, ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, ChatMessages(), ChatMessagesProps (+54 more)

### Community 20 - "systemPrompt.ts"
Cohesion: 0.53
Nodes (5): buildBaselinePrompt(), buildEnterprisePolicyPrompt(), buildStrictCitationPrompt(), getSystemPrompt(), PromptVariant

## Knowledge Gaps
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `chat-container.tsx` to `package.json`, `Project Dialogs and Controls`, `config.ts`, `dependencies`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.0742447516641065 - nodes in this community are weakly interconnected._
- **Why does `next` connect `config.ts` to `app/page.tsx`, `Project Dialogs and Controls`, `next.config.ts`, `dependencies`, `package.json`, `chat-container.tsx`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Should `config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05740740740740741 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `Component Library Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._