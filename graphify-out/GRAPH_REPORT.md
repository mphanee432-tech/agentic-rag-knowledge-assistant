# Graph Report - rag-knowledge-assistant  (2026-11-12)

## Corpus Check
- 59 files · ~18,205 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .ico 1, .css 1)

## Summary
- 399 nodes · 854 edges · 21 communities (16 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1383c1b1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Chat Interface and State
- Project Dialogs and Controls
- class-variance-authority
- login/page.tsx
- Prompt Evaluation Configuration
- Component Library Configuration
- Layout Theme and Styling
- TypeScript Compiler Configuration
- Application Runtime Dependencies
- HttpError
- Development and Evaluation Dependencies
- Project Commands
- chat/route.ts
- Workspace Build Permissions
- Lint Configuration
- Tailwind Theme Configuration
- package.json
- pdf-lib
- eval-dataset.ts
- react-dom
- @tailwindcss/turbopack@^4

## God Nodes (most connected - your core abstractions)
1. `Button()` - 28 edges
2. `ProjectCard()` - 27 edges
3. `react` - 25 edges
4. `HttpError` - 17 edges
5. `lucide-react` - 17 edges
6. `scripts` - 17 edges
7. `requireProject()` - 16 edges
8. `Badge()` - 16 edges
9. `compilerOptions` - 16 edges
10. `POST()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `apiError()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `HttpError`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `requireChatProject()`  [EXTRACTED]
  app/api/chat/route.ts → lib/auth.ts
- `POST()` --calls--> `createAdminClient()`  [EXTRACTED]
  app/api/chat/route.ts → lib/supabase/admin.ts
- `DashboardPage()` --calls--> `CreateProjectDialog()`  [EXTRACTED]
  app/page.tsx → components/dashboard/create-project-dialog.tsx

## Import Cycles
- None detected.

## Communities (21 total, 5 thin omitted)

### Community 0 - "Chat Interface and State"
Cohesion: 0.10
Nodes (39): ChatContainer(), ChatContainerProps, ChatInput(), ChatInputProps, ChatMessages(), ChatMessagesProps, CitationBadge(), CitationBadgeProps (+31 more)

### Community 1 - "Project Dialogs and Controls"
Cohesion: 0.08
Nodes (40): createProject(), renameProject(), FeedbackActions(), FeedbackActionsProps, ISSUE_TAGS, CreateProjectButton(), CreateProjectDialog(), CreateProjectDialogProps (+32 more)

### Community 3 - "login/page.tsx"
Cohesion: 0.13
Nodes (16): signOut(), LoginPage(), signIn(), DashboardPage(), RawProjectRecord, ProjectCardData, subscribe(), ThemeToggle() (+8 more)

### Community 4 - "Prompt Evaluation Configuration"
Cohesion: 0.07
Nodes (28): projectId, promptVariant, query, stream, apiKey, body, headers, method (+20 more)

### Community 5 - "Component Library Configuration"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 6 - "Layout Theme and Styling"
Cohesion: 0.12
Nodes (19): geistMono, geistSans, inter, metadata, RootLayout(), ThemeProvider(), Card(), CardContent() (+11 more)

### Community 7 - "TypeScript Compiler Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 8 - "Application Runtime Dependencies"
Cohesion: 0.11
Nodes (18): dependencies, @ai-sdk/google@^4.0.98, cn@^0.4.0, @google/genai@^2.30.0, lucide-react@^1.58.0, next@16.4.2, radix-ui@^1.8.1, react@19.3.0 (+10 more)

### Community 9 - "HttpError"
Cohesion: 0.13
Nodes (29): createProjectAction, deleteProject(), DELETE(), GET(), POST(), POST(), GET(), POST() (+21 more)

### Community 10 - "Development and Evaluation Dependencies"
Cohesion: 0.12
Nodes (17): devDependencies, dotenv@^18.0.8, supabase@^3.0.0, tsx@^4.23.15, @types/dotenv@^8.2.3, @types/node@^20, @types/react@^19, @types/react-dom@^19 (+9 more)

### Community 11 - "Project Commands"
Cohesion: 0.12
Nodes (17): scripts, build, dev, eval, eval:check, eval:generate, eval:prepare, eval:py:full (+9 more)

### Community 12 - "chat/route.ts"
Cohesion: 0.13
Nodes (25): errorMessage(), FailureCategory, FailureStage, POST(), runtime, assertValidAnswer(), ChatEvent, encodeEvent() (+17 more)

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
Nodes (10): ai@^7.0.142, remark-gfm@4.0.1, promptfoo@^0.124.1, name, packageManager, private, version, ai (+2 more)

## Knowledge Gaps
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Project Dialogs and Controls` to `Chat Interface and State`, `login/page.tsx`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `package.json`?**
  _High betweenness centrality (0.109) - this node is a cross-community bridge._
- **Should `Chat Interface and State` be split into smaller, more focused modules?**
  _Cohesion score 0.10159651669085631 - nodes in this community are weakly interconnected._
- **Why does `next` connect `login/page.tsx` to `Chat Interface and State`, `Project Dialogs and Controls`, `Layout Theme and Styling`, `Application Runtime Dependencies`, `HttpError`, `package.json`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Should `Project Dialogs and Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.08302485457429931 - nodes in this community are weakly interconnected._
- **Why does `scripts` connect `Project Commands` to `package.json`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Should `login/page.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `Prompt Evaluation Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._