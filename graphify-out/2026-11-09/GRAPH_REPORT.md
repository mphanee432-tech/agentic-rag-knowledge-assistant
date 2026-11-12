# Graph Report - rag-knowledge-assistant  (2026-11-08)

## Corpus Check
- 59 files · ~17,221 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 393 nodes · 827 edges · 22 communities (17 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1383c1b1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Chat Interface and State
- Project Dialogs and Controls
- shadcn@^4.21.5
- login/page.tsx
- Prompt Evaluation Configuration
- Component Library Configuration
- Layout Theme and Styling
- TypeScript Compiler Configuration
- Application Runtime Dependencies
- Document Ingestion and Chunking
- Development and Evaluation Dependencies
- Project Commands
- chat/route.ts
- Workspace Build Permissions
- Lint Configuration
- Tailwind Theme Configuration
- package.json
- message-item.tsx
- eval-dataset.ts
- tailwind-merge
- supabase@^3.0.0
- @types/dotenv@^8.2.3

## God Nodes (most connected - your core abstractions)
1. `Button()` - 28 edges
2. `ProjectCard()` - 27 edges
3. `react` - 25 edges
4. `requireProject()` - 17 edges
5. `lucide-react` - 17 edges
6. `scripts` - 17 edges
7. `Badge()` - 16 edges
8. `compilerOptions` - 16 edges
9. `HttpError` - 14 edges
10. `CreateProjectDialog()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `ChatMessagesProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/chat-messages.tsx → lib/store/chat-store.ts
- `CitationBadgeProps` --references--> `Citation`  [EXTRACTED]
  components/chat/citation-badge.tsx → lib/store/chat-store.ts
- `MessageItemProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/message-item.tsx → lib/store/chat-store.ts
- `DashboardPage()` --calls--> `CreateProjectDialog()`  [EXTRACTED]
  app/page.tsx → components/dashboard/create-project-dialog.tsx
- `DashboardPage()` --calls--> `ProjectCard()`  [EXTRACTED]
  app/page.tsx → components/dashboard/project-card.tsx

## Import Cycles
- None detected.

## Communities (22 total, 5 thin omitted)

### Community 0 - "Chat Interface and State"
Cohesion: 0.10
Nodes (41): signOut(), DashboardPage(), RawProjectRecord, ProjectPageProps, ProjectWorkspacePage(), ChatContainer(), ChatContainerProps, ChatInput() (+33 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.08
Nodes (37): createProject(), createProjectAction, deleteProject(), renameProject(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard(), ProjectCardData (+29 more)

### Community 3 - "login/page.tsx"
Cohesion: 0.27
Nodes (6): LoginPage(), signIn(), createBrowserClient(), @supabase/ssr@^0.12.7, config, @supabase/ssr

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.14
Nodes (17): geistMono, geistSans, inter, metadata, RootLayout(), ThemeProvider(), Card(), CardContent() (+9 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "Application Runtime Dependencies"
Cohesion: 0.12
Nodes (17): dependencies, ai@^7.0.142, @ai-sdk/google@^4.0.98, class-variance-authority@^0.7.1, cn@^0.4.0, lucide-react@^1.58.0, next@16.4.2, react@19.3.0 (+9 more)

### Community 9 - "Document Ingestion and Chunking"
Cohesion: 0.16
Nodes (15): InvalidDocumentError, maxDuration, POST(), runtime, checkIsTabular(), ChunkMetadata, DocumentChunk, estimateTokens() (+7 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.13
Nodes (15): devDependencies, dotenv@^18.0.8, promptfoo@^0.124.1, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/react@^19, @types/react-dom@^19, typescript@^5 (+7 more)

### Community 11 - "Project Commands"
Cohesion: 0.12
Nodes (17): scripts, build, dev, eval, eval:check, eval:generate, eval:prepare, eval:py:full (+9 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.13
Nodes (30): errorMessage(), POST(), runtime, DELETE(), GET(), POST(), POST(), GET() (+22 more)

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
Nodes (10): remark-gfm@4.0.1, zustand@^5.0.15, @types/node@^20, name, packageManager, private, version, remark-gfm (+2 more)

### Community 17 - "message-item.tsx"
Cohesion: 0.15
Nodes (19): ChatMessages(), ChatMessagesProps, CitationBadge(), CitationBadgeProps, ISSUE_TAGS, MessageActions(), MessageActionsProps, FormattedContent() (+11 more)

## Knowledge Gaps
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Chat Interface and State` to `Project Dialogs and Controls`, `login/page.tsx`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `package.json`, `message-item.tsx`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **Should `Chat Interface and State` be split into smaller, more focused modules?**
  _Cohesion score 0.0955837870538415 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Chat Interface and State` to `Project Dialogs and Controls`, `login/page.tsx`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `package.json`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.08082706766917293 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `Component Library Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._