# Graph Report - rag-knowledge-assistant  (2026-11-14)

## Corpus Check
- 69 files · ~25,632 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 458 nodes · 1060 edges · 21 communities (18 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7b68e418`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Chat Interface and State
- Project Dialogs and Controls
- next.config.ts
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
- @google/genai
- pdf-lib

## God Nodes (most connected - your core abstractions)
1. `Button()` - 32 edges
2. `HttpError` - 29 edges
3. `requireUser()` - 29 edges
4. `react` - 28 edges
5. `ProjectCard()` - 27 edges
6. `apiError()` - 21 edges
7. `POST()` - 19 edges
8. `lucide-react` - 18 edges
9. `scripts` - 18 edges
10. `requireProject()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `verifyRecoverySession()` --calls--> `createBrowserClient()`  [EXTRACTED]
  app/reset-password/page.tsx → lib/supabase/client.ts
- `handleSubmit()` --calls--> `createBrowserClient()`  [EXTRACTED]
  app/reset-password/page.tsx → lib/supabase/client.ts
- `CitationBadgeProps` --references--> `Citation`  [EXTRACTED]
  components/chat/citation-badge.tsx → lib/store/chat-store.ts
- `ChatMessagesProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/chat-messages.tsx → lib/store/chat-store.ts
- `MessageItemProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/message-item.tsx → lib/store/chat-store.ts

## Import Cycles
- None detected.

## Communities (21 total, 3 thin omitted)

### Community 0 - "Chat Interface and State"
Cohesion: 0.09
Nodes (47): ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, ChatMessages(), ChatMessagesProps, CitationBadge(), CitationBadgeProps (+39 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.08
Nodes (40): createProject(), renameProject(), CreateProjectButton(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard(), ProjectCardProps, AlertDialog() (+32 more)

### Community 2 - "next.config.ts"
Cohesion: 0.33
Nodes (3): nextConfig, dotenv@^18.0.8, dotenv

### Community 3 - "app/page.tsx"
Cohesion: 0.17
Nodes (14): signOut(), DashboardPage(), RawProjectRecord, ProjectCardData, SignOut(), subscribe(), ThemeToggle(), createClient (+6 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.09
Nodes (32): geistMono, geistSans, inter, metadata, RootLayout(), clearPendingDepartmentCookie(), completeDemoOnboarding(), getPendingDepartmentCookie() (+24 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "dependencies"
Cohesion: 0.10
Nodes (20): dependencies, ai@^7.0.142, cn@^0.4.0, lucide-react@^1.58.0, next@16.4.2, radix-ui@^1.8.1, react@19.3.0, react-dom@19.3.0 (+12 more)

### Community 9 - "HttpError"
Cohesion: 0.14
Nodes (34): createProjectAction, deleteProject(), DELETE(), GET(), POST(), GET(), GET(), getGeminiErrorStatus() (+26 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.11
Nodes (19): devDependencies, promptfoo@^0.124.1, supabase@^3.0.0, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react@^19 (+11 more)

### Community 11 - "Project Commands"
Cohesion: 0.11
Nodes (18): scripts, build, dev, dev:test, eval, eval:check, eval:generate, eval:prepare (+10 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.11
Nodes (30): errorMessage(), FailureCategory, FailureStage, POST(), runtime, sanitizeProviderError(), assertValidAnswer(), ChatEvent (+22 more)

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
Cohesion: 0.15
Nodes (12): @ai-sdk/google@^4.0.98, class-variance-authority@^0.7.1, clsx@^2.1.1, remark-gfm@4.0.1, name, packageManager, private, version (+4 more)

### Community 17 - "storage/route.ts"
Cohesion: 0.23
Nodes (11): InvalidDocumentError, maxDuration, POST(), runtime, checkIsTabular(), ChunkMetadata, DocumentChunk, estimateTokens() (+3 more)

## Knowledge Gaps
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Chat Interface and State` to `Project Dialogs and Controls`, `app/page.tsx`, `Layout Theme and Styling`, `dependencies`, `package.json`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Should `Chat Interface and State` be split into smaller, more focused modules?**
  _Cohesion score 0.0855094726062468 - nodes in this community are weakly interconnected._
- **Why does `next` connect `app/page.tsx` to `Chat Interface and State`, `Project Dialogs and Controls`, `next.config.ts`, `Layout Theme and Styling`, `dependencies`, `HttpError`, `package.json`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.08243727598566308 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `Component Library Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._