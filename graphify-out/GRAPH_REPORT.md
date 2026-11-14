# Graph Report - rag-knowledge-assistant  (2026-11-13)

## Corpus Check
- 66 files · ~24,194 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 445 nodes · 1020 edges · 23 communities (18 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `78e4dda1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Chat Interface and State
- Project Dialogs and Controls
- message-item.tsx
- app/page.tsx
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
- storage/route.ts
- eval-dataset.ts
- tailwind-merge
- tw-animate-css@^1.4.0
- @types/react@^19
- supabase@^3.0.0

## God Nodes (most connected - your core abstractions)
1. `Button()` - 32 edges
2. `HttpError` - 27 edges
3. `ProjectCard()` - 27 edges
4. `requireUser()` - 27 edges
5. `react` - 27 edges
6. `POST()` - 19 edges
7. `apiError()` - 19 edges
8. `lucide-react` - 18 edges
9. `scripts` - 18 edges
10. `requireProject()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `getEnterpriseCopilotContext()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `HttpError`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireChatProject()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireUser()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `createAdminClient()`  [EXTRACTED]
  app/api/chat/route.ts → lib/supabase/admin.ts

## Import Cycles
- None detected.

## Communities (23 total, 5 thin omitted)

### Community 0 - "Chat Interface and State"
Cohesion: 0.15
Nodes (26): ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, CitationBadgeProps, ProjectWorkspaceClient(), ProjectWorkspaceClientProps, Sidebar() (+18 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.08
Nodes (44): renameProject(), FeedbackActions(), FeedbackActionsProps, ISSUE_TAGS, CreateProjectButton(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard() (+36 more)

### Community 2 - "message-item.tsx"
Cohesion: 0.16
Nodes (16): ChatMessages(), ChatMessagesProps, CitationBadge(), ISSUE_TAGS, MessageActions(), MessageActionsProps, FormattedContent(), MarkdownNode (+8 more)

### Community 3 - "app/page.tsx"
Cohesion: 0.13
Nodes (15): signOut(), DashboardPage(), RawProjectRecord, ProjectCardData, SignOut(), subscribe(), ThemeToggle(), getEnterpriseCopilotContext() (+7 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.11
Nodes (25): geistMono, geistSans, inter, metadata, RootLayout(), clearPendingDepartmentCookie(), completeDemoOnboarding(), getPendingDepartmentCookie() (+17 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.11
Nodes (18): dependencies, @ai-sdk/google@^4.0.98, class-variance-authority@^0.7.1, cn@^0.4.0, lucide-react@^1.58.0, next@16.4.2, next-themes@^0.4.6, radix-ui@^1.8.1 (+10 more)

### Community 9 - "HttpError"
Cohesion: 0.20
Nodes (22): createProject(), createProjectAction, deleteProject(), DELETE(), GET(), POST(), GET(), GET() (+14 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.13
Nodes (15): devDependencies, dotenv@^18.0.8, promptfoo@^0.124.1, @tailwindcss/turbopack@^4, @types/dotenv@^8.2.3, @types/node@^20, @types/react-dom@^19, typescript@^5 (+7 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.11
Nodes (32): errorMessage(), FailureCategory, FailureStage, POST(), runtime, sanitizeProviderError(), assertValidAnswer(), ChatEvent (+24 more)

### Community 13 - "Workspace Build Permissions"
Cohesion: 0.25
Nodes (7): allowBuilds, esbuild, @google/genai, protobufjs, sharp, supabase, unrs-resolver

### Community 14 - "Lint Configuration"
Cohesion: 0.33
Nodes (5): eslintConfig, eslint@^9, eslint-config-next@16.4.2, eslint, eslint-config-next

### Community 15 - "Tailwind Theme Configuration"
Cohesion: 0.50
Nodes (3): tailwindcss@^4, tailwindcss, config

### Community 16 - "package.json"
Cohesion: 0.18
Nodes (10): ai@^7.0.142, clsx@^2.1.1, tsx@^4.23.15, name, packageManager, private, version, ai (+2 more)

### Community 17 - "storage/route.ts"
Cohesion: 0.12
Nodes (25): getGeminiErrorStatus(), InvalidDocumentError, isAbortOrTimeoutError(), isTransientGeminiError(), maxDuration, POST(), RetryOptions, runtime (+17 more)

## Knowledge Gaps
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Project Dialogs and Controls` to `Chat Interface and State`, `message-item.tsx`, `app/page.tsx`, `Layout Theme and Styling`, `dependencies`, `package.json`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.0792838874680307 - nodes in this community are weakly interconnected._
- **Why does `next` connect `app/page.tsx` to `Chat Interface and State`, `Project Dialogs and Controls`, `Layout Theme and Styling`, `dependencies`, `HttpError`, `package.json`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Should `app/page.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13405797101449277 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `Component Library Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._