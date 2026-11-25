# Graph Report - Agentic-rag-knowledge-assistant  (2026-11-22)

## Corpus Check
- 83 files · ~35,487 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 585 nodes · 1489 edges · 21 communities (19 shown, 2 thin omitted)
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
- Layout Theme and Styling
- TypeScript Compiler Configuration
- dependencies
- HttpError
- Development and Evaluation Dependencies
- Project Commands
- chat/route.ts
- Workspace Build Permissions
- Lint Configuration
- Tailwind Theme Configuration
- package.json
- ingest/route.ts
- eval-dataset.ts
- chat-container.tsx
- @ai-sdk/google

## God Nodes (most connected - your core abstractions)
1. `HttpError` - 41 edges
2. `Button()` - 37 edges
3. `requireUser()` - 36 edges
4. `react` - 30 edges
5. `ProjectCard()` - 27 edges
6. `POST()` - 26 edges
7. `apiError()` - 26 edges
8. `ChatContainer()` - 20 edges
9. `lucide-react` - 19 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `getEnterpriseCopilotContext()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `HttpError`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `isJiraAccessAvailable()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireChatProject()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireUser()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts

## Import Cycles
- None detected.

## Communities (21 total, 2 thin omitted)

### Community 0 - "app/page.tsx"
Cohesion: 0.13
Nodes (25): DashboardPage(), DashboardPageProps, RawProjectRecord, ProjectPageProps, ProjectWorkspacePage(), AccountSummary(), AccountSummaryProps, ChatContainerProps (+17 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.07
Nodes (41): createProject(), createProjectAction, deleteProject(), renameProject(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard(), ProjectCardProps (+33 more)

### Community 2 - "next.config.ts"
Cohesion: 0.33
Nodes (3): nextConfig, dotenv@^18.0.8, dotenv

### Community 3 - "config.ts"
Cohesion: 0.08
Nodes (46): signOut(), geistMono, geistSans, inter, metadata, RootLayout(), RecoveryStatus, ResetPasswordForm() (+38 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.17
Nodes (20): clearPendingDepartmentCookie(), completeDemoOnboarding(), getPendingDepartmentCookie(), LoginForm(), handleSubmit(), LoginPage(), setPendingDepartmentCookie(), EnterpriseOnboardCard() (+12 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, ai@^7.0.142, class-variance-authority@^0.7.1, clsx@^2.1.1, cn@^0.4.0, @google/genai@^2.30.0, lucide-react@^1.58.0, next@16.4.6 (+12 more)

### Community 9 - "HttpError"
Cohesion: 0.10
Nodes (50): DELETE(), GET(), POST(), GET(), GET(), GET(), POST(), POST() (+42 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.11
Nodes (19): devDependencies, promptfoo@^0.124.1, supabase@^3.0.0, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react@^19 (+11 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.05
Nodes (60): EnterpriseRejectionReason, errorMessage(), FailureCategory, FailureStage, POST(), runtime, sanitizeProviderError(), AgentTool (+52 more)

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
Nodes (12): react-dom@19.3.0, react-markdown@10.1.0, tailwind-merge@^3.7.0, tw-animate-css@^1.4.0, name, packageManager, private, version (+4 more)

### Community 17 - "ingest/route.ts"
Cohesion: 0.15
Nodes (26): InvalidDocumentError, maxDuration, POST(), runtime, InvalidDocumentError, maxDuration, POST(), runtime (+18 more)

### Community 19 - "chat-container.tsx"
Cohesion: 0.08
Nodes (52): ChatContainer(), ChatInput(), ChatInputProps, ChatMessages(), ChatMessagesProps, CitationBadge(), CitationBadgeProps, FeedbackActions() (+44 more)

## Knowledge Gaps
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `chat-container.tsx` to `Project Dialogs and Controls`, `config.ts`, `Layout Theme and Styling`, `dependencies`, `HttpError`, `package.json`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Should `app/page.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.1310344827586207 - nodes in this community are weakly interconnected._
- **Why does `next` connect `config.ts` to `app/page.tsx`, `Project Dialogs and Controls`, `next.config.ts`, `Layout Theme and Styling`, `dependencies`, `package.json`, `chat-container.tsx`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.07291666666666667 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `config.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08469449485783424 - nodes in this community are weakly interconnected._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._