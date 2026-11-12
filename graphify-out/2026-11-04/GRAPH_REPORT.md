# Graph Report - rag-knowledge-assistant  (2026-11-04)

## Corpus Check
- 59 files · ~16,651 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 384 nodes · 813 edges · 21 communities (18 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1383c1b1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Chat Interface and State
- Project Dialogs and Controls
- requireProject
- Authentication and Page Routing
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
- @types/dotenv@^8.2.3
- @types/react-dom@^19

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
- `CitationBadgeProps` --references--> `Citation`  [EXTRACTED]
  components/chat/citation-badge.tsx → lib/store/chat-store.ts
- `ChatMessagesProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/chat-messages.tsx → lib/store/chat-store.ts
- `MessageItemProps` --references--> `ChatMessage`  [EXTRACTED]
  components/chat/message-item.tsx → lib/store/chat-store.ts
- `POST()` --calls--> `HttpError`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `ProjectWorkspacePage()` --calls--> `ProjectWorkspaceClient()`  [EXTRACTED]
  app/project/[id]/page.tsx → components/chat/project-workspace-client.tsx

## Import Cycles
- None detected.

## Communities (21 total, 3 thin omitted)

### Community 0 - "Chat Interface and State"
Cohesion: 0.11
Nodes (37): ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, CitationBadgeProps, FeedbackActions(), FeedbackActionsProps, ISSUE_TAGS (+29 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.09
Nodes (32): createProject(), CreateProjectDialog(), CreateProjectDialogProps, ProjectCard(), ProjectCardProps, AlertDialog(), AlertDialogAction(), AlertDialogCancel() (+24 more)

### Community 2 - "requireProject"
Cohesion: 0.28
Nodes (15): createProjectAction, deleteProject(), renameProject(), DELETE(), GET(), POST(), POST(), GET() (+7 more)

### Community 3 - "Authentication and Page Routing"
Cohesion: 0.13
Nodes (16): signOut(), LoginPage(), signIn(), DashboardPage(), RawProjectRecord, ProjectPageProps, ProjectWorkspacePage(), ProjectCardData (+8 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.16
Nodes (15): geistMono, geistSans, inter, metadata, RootLayout(), ThemeProvider(), Card(), CardContent() (+7 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "Application Runtime Dependencies"
Cohesion: 0.12
Nodes (16): dependencies, class-variance-authority@^0.7.1, clsx@^2.1.1, cn@^0.4.0, lucide-react@^1.58.0, next@16.4.2, radix-ui@^1.8.1, react@19.3.0 (+8 more)

### Community 9 - "Document Ingestion and Chunking"
Cohesion: 0.16
Nodes (15): InvalidDocumentError, maxDuration, POST(), runtime, checkIsTabular(), ChunkMetadata, DocumentChunk, estimateTokens() (+7 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.13
Nodes (15): devDependencies, dotenv@^18.0.8, promptfoo@^0.124.1, @tailwindcss/turbopack@^4, tsx@^4.23.15, @types/node@^20, @types/react@^19, typescript@^5 (+7 more)

### Community 11 - "Project Commands"
Cohesion: 0.12
Nodes (17): scripts, build, dev, eval, eval:check, eval:generate, eval:prepare, eval:py:full (+9 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.13
Nodes (22): errorMessage(), POST(), runtime, assertValidAnswer(), ChatEvent, encodeEvent(), MAX_ANSWER_CHARS, NO_EVIDENCE (+14 more)

### Community 13 - "Workspace Build Permissions"
Cohesion: 0.29
Nodes (6): allowBuilds, esbuild, @google/genai, protobufjs, sharp, unrs-resolver

### Community 14 - "Lint Configuration"
Cohesion: 0.33
Nodes (5): eslintConfig, eslint@^9, eslint-config-next@16.4.2, eslint, eslint-config-next

### Community 15 - "Tailwind Theme Configuration"
Cohesion: 0.50
Nodes (3): tailwindcss@^4, tailwindcss, config

### Community 16 - "package.json"
Cohesion: 0.18
Nodes (10): ai@^7.0.142, @ai-sdk/google@^4.0.98, react-dom@19.3.0, name, packageManager, private, version, ai (+2 more)

### Community 17 - "message-item.tsx"
Cohesion: 0.29
Nodes (11): ChatMessages(), ChatMessagesProps, CitationBadge(), ISSUE_TAGS, MessageActions(), MessageActionsProps, CodeBlock(), FormattedContent() (+3 more)

## Knowledge Gaps
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Chat Interface and State` to `Project Dialogs and Controls`, `Authentication and Page Routing`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `package.json`, `message-item.tsx`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Should `Chat Interface and State` be split into smaller, more focused modules?**
  _Cohesion score 0.11450980392156863 - nodes in this community are weakly interconnected._
- **Why does `next` connect `Authentication and Page Routing` to `Chat Interface and State`, `Project Dialogs and Controls`, `requireProject`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `package.json`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.09176470588235294 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Should `Authentication and Page Routing` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._